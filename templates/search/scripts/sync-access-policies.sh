#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# sync-access-policies.sh - idempotently sync Cloudflare Access policies.
#
# Mirrors the logic driven by .github/actions/sync-access-policies/action.yml,
# extracted so it can be run locally and unit-tested in isolation.
#
# Lockout-safe ordering: inputs are validated BEFORE any mutation, the NEW
# policies are created first (at precedences that don't collide with anything
# already on the app), and only after every create succeeds are the OLD
# policies deleted. A failure at any point leaves the previous, working
# policies in place — a working KB can never be left with zero policies.
#
# Ownership: only policies whose name is EXACTLY one of MANAGED_NAMES are ever
# deleted. Everything else on the app belongs to the tenant and is reported,
# never removed. Deletion is then VERIFIED by re-reading the app: a policy we
# meant to remove that is still there fails the deploy, because a revocation
# that silently did nothing is the failure mode this script must not have.
#
# Required environment variables:
#   CLOUDFLARE_API_TOKEN   Cloudflare API token
#   CLOUDFLARE_ACCOUNT_ID  Cloudflare account ID
#   APP_ID                 Cloudflare Access application ID
#
# Optional environment variables:
#   EMAIL_DOMAIN   Primary staff email domain for the allow policy. Unset/empty
#                  = NO domain-level access (restrict via CLIENT_EMAILS instead).
#   CLIENT_EMAILS  Comma-separated client email addresses to allow
#   CLIENT_DOMAIN  Single client email domain to allow
#   OFFICE_CIDRS   Comma-separated office CIDRs that bypass auth entirely
#
# Overrides for testing:
#   CURL           curl binary to invoke (default: curl)
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${APP_ID:?APP_ID is required}"

# No colon and no default: an EXPLICIT empty string must stay empty. Using
# ":-rocketlab.com.au" here silently re-broadened access to a whole domain when
# a KB intentionally set EMAIL_DOMAIN="" to restrict to specific emails. The
# product is tenant-neutral, so there is no default staff domain either.
EMAIL_DOMAIN="${EMAIL_DOMAIN-}"
CLIENT_EMAILS="${CLIENT_EMAILS:-}"
CLIENT_DOMAIN="${CLIENT_DOMAIN:-}"
OFFICE_CIDRS="${OFFICE_CIDRS:-}"
CURL="${CURL:-curl}"

BASE="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/access"
ALLOW_NAME="Allow staff + clients"
BYPASS_NAME="Office network bypass"

# Every policy name this project's tooling has ever created. A policy is deleted
# ONLY if its name matches one of these by EXACT string equality — no case
# folding, no trimming, no prefix match. Anything else on the app was put there
# by the tenant (the documented way to grant a one-off reader) and is theirs.
#
# Enumerated from live Access data on 2026-08-14 (#238): 50 apps, 57 policies,
# 13 distinct names, of which these four cover 44. Do not prune this list without
# re-measuring — the asymmetry is deliberate. A MISSING name orphans every policy
# carrying it: visible, a duplicate beside the new one. An EXTRA name deletes a
# tenant's own grant: invisible, and it locks a client out of their own docs.
#
# Near-misses stay out for the same reason: "Allow Rocketlab", "Allow rocketlab"
# and "Allow rocketlab staging" are live but match no string this tooling has
# ever emitted, so they are hand-created and are not ours to delete.
MANAGED_NAMES=(
  "Allow staff + clients"       # current ALLOW_NAME, above
  "Office network bypass"       # current BYPASS_NAME, above — 0 live, still required:
                                # this script creates it whenever OFFICE_CIDRS is set
  "Allow Rocket Lab + clients"  # docs-playbook's ALLOW_NAME — still what it writes TODAY,
                                # and live on already-registered KBs
  "Allow Rocket Lab emails"     # first-generation deploy-pages.yml, pre-rename
)
MANAGED_JSON=$(printf '%s\n' "${MANAGED_NAMES[@]}" | jq -R . | jq -sc .)

# Split a comma-separated list into an array, tolerating newlines.
# `read` stops at the first newline no matter what IFS says, so a value pasted
# one-per-line into a repo variable (OFFICE_CIDRS) or passed as a YAML block
# scalar silently lost everything after line 1 — and a value that STARTED with a
# newline produced zero items, which for CLIENT_EMAILS meant an empty allow
# policy: the KB deployed LOCKED and every old policy was deleted. Normalise
# newlines to separators first so the whole list survives.
split_list() {
  local raw=$1
  raw="${raw//$'\r'/,}"
  raw="${raw//$'\n'/,}"
  IFS=',' read -ra _split_out <<< "$raw"
}

# Quote-safe whitespace trim. NOT xargs: xargs interprets quotes/backslashes,
# so an item containing them gets mangled (or kills the command outright).
trim() {
  local s=$1
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# ── Validate ALL inputs before ANY mutation ──
# A malformed CIDR/email used to surface only when Cloudflare rejected the
# create — after the old policies were already deleted, locking everyone out.
VALID_EMAILS=()
if [ -n "$CLIENT_EMAILS" ]; then
  split_list "$CLIENT_EMAILS"
  for e in "${_split_out[@]}"; do
    e_trim=$(trim "$e")
    [ -z "$e_trim" ] && continue
    if [[ ! "$e_trim" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
      echo "::error::Invalid email in CLIENT_EMAILS: '${e_trim}'. No policies were changed."
      exit 1
    fi
    VALID_EMAILS+=("$e_trim")
  done
fi

VALID_CIDRS=()
if [ -n "$OFFICE_CIDRS" ]; then
  split_list "$OFFICE_CIDRS"
  for c in "${_split_out[@]}"; do
    c_trim=$(trim "$c")
    [ -z "$c_trim" ] && continue
    # Both address families: Cloudflare Access ip includes accept IPv4 and
    # IPv6 CIDRs (and bare IPs), and IPv6 office ranges predate this check —
    # rejecting them would hard-fail every deploy for those tenants.
    if [[ "$c_trim" == *:* ]]; then
      if [[ ! "$c_trim" =~ ^[0-9A-Fa-f:.]+(/[0-9]+)?$ ]]; then
        echo "::error::Invalid CIDR in OFFICE_CIDRS: '${c_trim}' (expected an IPv6 CIDR like 2001:db8::/32). No policies were changed."
        exit 1
      fi
      _max=128
    else
      if [[ ! "$c_trim" =~ ^[0-9.]+(/[0-9]+)?$ ]]; then
        echo "::error::Invalid CIDR in OFFICE_CIDRS: '${c_trim}' (expected a.b.c.d/prefix). No policies were changed."
        exit 1
      fi
      _max=32
    fi
    if [[ "$c_trim" == */* ]]; then
      _prefix="${c_trim##*/}"
      if [ "$((10#$_prefix))" -gt "$_max" ]; then
        echo "::error::Invalid CIDR prefix in OFFICE_CIDRS: '${c_trim}' (prefix must be 0-${_max}). No policies were changed."
        exit 1
      fi
    fi
    VALID_CIDRS+=("$c_trim")
  done
fi

# ── Build allow-policy include array ──
if [ -n "$EMAIL_DOMAIN" ]; then
  ALLOW_INCLUDES=$(jq -nc --arg d "$EMAIL_DOMAIN" \
    '[{email_domain:{domain:$d}}]')
else
  ALLOW_INCLUDES='[]'
fi

if [ -n "$CLIENT_DOMAIN" ]; then
  ALLOW_INCLUDES=$(jq -c --arg d "$CLIENT_DOMAIN" \
    '. + [{email_domain:{domain:$d}}]' <<<"$ALLOW_INCLUDES")
fi

if [ "${#VALID_EMAILS[@]}" -gt 0 ]; then
  for e_trim in "${VALID_EMAILS[@]}"; do
    ALLOW_INCLUDES=$(jq -c --arg e "$e_trim" \
      '. + [{email:{email:$e}}]' <<<"$ALLOW_INCLUDES")
  done
fi

# ── Build bypass-policy include array ──
BYPASS_INCLUDES="[]"
if [ "${#VALID_CIDRS[@]}" -gt 0 ]; then
  for c_trim in "${VALID_CIDRS[@]}"; do
    BYPASS_INCLUDES=$(jq -c --arg c "$c_trim" \
      '. + [{ip:{ip:$c}}]' <<<"$BYPASS_INCLUDES")
  done
fi

# ── List ALL existing policies (paginated, check API success first) ──
# A function, not a straight-line block: the post-delete read-back below needs
# exactly this walk, and a second hand-written copy is a second place for the
# pagination to be wrong. Its result lands in LIST_RESULT rather than on stdout,
# because ::error:: annotations must reach the log — a command substitution
# would swallow them.
LIST_RESULT='[]'
list_policies() {
  LIST_RESULT='[]'
  local page=1 resp page_result count total_pages
  while true; do
    # `|| resp=''` rather than relying on errexit: this function is called from
    # an `if`, which disables errexit for its whole body. A dead API must still
    # be an error, not an empty policy list treated as "nothing to delete".
    resp=$("$CURL" -sS "${BASE}/apps/${APP_ID}/policies?page=${page}&per_page=50" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}") || resp=''
    if [ "$(jq -r '.success // false' <<<"$resp" 2>/dev/null)" != "true" ]; then
      echo "::error::Failed to list policies (page ${page})"
      jq -r '.errors // [] | .[] | "  code=\(.code) message=\(.message)"' <<<"$resp" >&2 || true
      return 1
    fi
    page_result=$(jq -c '.result // []' <<<"$resp")
    LIST_RESULT=$(jq -c --argjson page "$page_result" '. + $page' <<<"$LIST_RESULT")
    count=$(jq -r 'length' <<<"$page_result")
    total_pages=$(jq -r '.result_info.total_pages // 1' <<<"$resp")
    # Non-numeric answers would make the arithmetic below fail, and with errexit
    # disabled that is an infinite pagination loop rather than an abort.
    [[ "$count" =~ ^[0-9]+$ ]] || count=0
    [[ "$total_pages" =~ ^[0-9]+$ ]] || total_pages=1
    if [ "$page" -ge "$total_pages" ] || [ "$count" = "0" ] || [ "$page" -ge 100 ]; then
      break
    fi
    page=$((page + 1))
  done
}

if ! list_policies; then
  exit 1
fi
EXISTING="$LIST_RESULT"

echo "Existing policies:"
jq -r '.[] | "  \(.id) prec=\(.precedence) \(.name)"' <<<"$EXISTING"

# ── Report what is NOT ours, before touching anything ──
# Emitted before any mutation so it survives an abort further down. This is the
# whole visible half of the ownership fix: the policies named here are the ones
# the script used to delete without asking, and a tenant who wanted them gone
# now has to say so in the dashboard.
FOREIGN=$(jq -c --argjson m "$MANAGED_JSON" \
  '[.[] | select((.name as $n | $m | index($n)) | not)]' <<<"$EXISTING")
FOREIGN_COUNT=$(jq -r 'length' <<<"$FOREIGN")
if [ "$FOREIGN_COUNT" -gt 0 ]; then
  FOREIGN_DESC=$(jq -r \
    'map("\"\(.name)\" [\(.decision // "unknown"), prec=\(.precedence)]") | join(", ")' <<<"$FOREIGN")
  if [ "$FOREIGN_COUNT" = "1" ]; then
    FOREIGN_MSG="1 policy on this app was not created by Glassdocs and is left untouched: ${FOREIGN_DESC}. It may grant access this repo does not declare. Remove it in the Cloudflare dashboard if unwanted."
  else
    FOREIGN_MSG="${FOREIGN_COUNT} policies on this app were not created by Glassdocs and are left untouched: ${FOREIGN_DESC}. They may grant access this repo does not declare. Remove them in the Cloudflare dashboard if unwanted."
  fi
  # LOCKED (no allow includes at all) plus a surviving foreign grant is a
  # contradiction the tenant has to see: the deploy is about to report the KB
  # locked while somebody can still get in. Not an error — never deleting a
  # foreign policy is the decision, and an intentional lock must stay shippable.
  if [ "$ALLOW_INCLUDES" = "[]" ]; then
    echo "::warning::${FOREIGN_MSG} This KB is NOT fully locked — the policies above still grant access."
  else
    echo "::notice::${FOREIGN_MSG}"
  fi
fi

# Pick precedences for the NEW policies that collide with nothing currently on
# the app (the old policies are still present at this point — create-first).
USED_PRECS=$(jq -r '[.[].precedence] | sort | .[]' <<<"$EXISTING")
next_prec() {
  local candidate=$1
  local taken="$2"
  while echo "$taken" | grep -qx "$candidate"; do
    candidate=$((candidate + 1))
  done
  echo "$candidate"
}

if [ "$BYPASS_INCLUDES" != "[]" ]; then
  BYPASS_PREC=$(next_prec 1 "$USED_PRECS")
  ALLOW_PREC=$(next_prec $((BYPASS_PREC + 1)) "$USED_PRECS"$'\n'"$BYPASS_PREC")
else
  BYPASS_PREC=""
  ALLOW_PREC=$(next_prec 1 "$USED_PRECS")
fi

# ── Create the NEW bypass policy first (if any office CIDRs) ──
if [ "$BYPASS_INCLUDES" != "[]" ]; then
  payload=$(jq -nc \
    --arg name "$BYPASS_NAME" \
    --argjson inc "$BYPASS_INCLUDES" \
    --argjson prec "$BYPASS_PREC" \
    '{name:$name, decision:"bypass", precedence:$prec, include:$inc}')
  resp=$("$CURL" -sS -X POST "${BASE}/apps/${APP_ID}/policies" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$payload")
  if [ "$(jq -r '.success // false' <<<"$resp")" != "true" ]; then
    echo "::error::Failed to create bypass policy — existing policies left untouched, access is unchanged."
    echo "$resp" >&2
    exit 1
  fi
  echo "Created bypass policy at precedence $BYPASS_PREC ($(jq 'length' <<<"$BYPASS_INCLUDES") CIDR rule(s))"
fi

# ── Create the NEW allow policy ──
# Fail-closed: with zero include rules (EMAIL_DOMAIN / CLIENT_DOMAIN /
# CLIENT_EMAILS all empty), do NOT create an allow policy. Cloudflare rejects
# include:[] ("include field should not be empty"), and — more to the point — an
# Access app with no allow policy is precisely the intended locked state: the
# domain is gated and nobody is granted in. So skip and report LOCKED rather
# than fail the deploy (the old policies are still removed below — locking the
# KB is the caller's declared intent).
if [ "$ALLOW_INCLUDES" = "[]" ]; then
  echo "::warning::No access rules set (EMAIL_DOMAIN / CLIENT_DOMAIN / CLIENT_EMAILS all empty) — deploying LOCKED. The Access app gates the site and no one is granted access yet; set one of those to grant access."
  echo "Fail-closed: no allow policy created (site is locked)."
else
  payload=$(jq -nc \
    --arg name "$ALLOW_NAME" \
    --argjson inc "$ALLOW_INCLUDES" \
    --argjson prec "$ALLOW_PREC" \
    '{name:$name, decision:"allow", precedence:$prec, include:$inc}')
  echo "Creating allow policy with $(jq 'length' <<<"$ALLOW_INCLUDES") include rule(s)..."
  echo "Payload: $payload"
  resp=$("$CURL" -sS -X POST "${BASE}/apps/${APP_ID}/policies" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$payload")
  if [ "$(jq -r '.success // false' <<<"$resp")" != "true" ]; then
    echo "::error::Failed to create allow policy — existing policies left untouched, access is unchanged."
    echo "$resp" >&2
    exit 1
  fi
  echo "Created allow policy at precedence $ALLOW_PREC ($(jq 'length' <<<"$ALLOW_INCLUDES") include rule(s))"
fi

# ── Only now delete the OLD MANAGED policies (every create above succeeded) ──
# `.name as $n | $m | index($n)` and not `$m | index(.name)`: the naive form
# re-binds `.` to the array and dies with `Cannot index array with string
# "name"`. index() returning 0 for the first match is truthy in jq — only null
# and false are falsy — so a name at position 0 is correctly kept.
OLD_IDS=$(jq -r --argjson m "$MANAGED_JSON" \
  '.[] | select(.name as $n | $m | index($n)) | .id' <<<"$EXISTING")
INTENDED=()
for pid in $OLD_IDS; do
  pname=$(jq -r --arg id "$pid" '.[] | select(.id==$id) | .name' <<<"$EXISTING")
  echo "Deleting old policy: $pname ($pid)"
  INTENDED+=("$pid")
  del_resp=$("$CURL" -sS -X DELETE \
    "${BASE}/apps/${APP_ID}/policies/${pid}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
  if [ "$(jq -r '.success // false' <<<"$del_resp")" != "true" ]; then
    # Kept as a warning, and it is now diagnostic rather than the verdict: it
    # names the Cloudflare error message, which the read-back below cannot. A
    # delete that REPORTED failure but actually took effect no longer fails the
    # deploy; the read-back decides.
    echo "::warning::Failed to delete old policy $pname ($pid): $(jq -r '.errors[0].message // "unknown"' <<<"$del_resp"). It remains on the app alongside the new policies — remove it manually if unwanted (it may be an undeletable reusable policy)."
  fi
done

# ── Verify the deletes actually landed ──
# Deliberately stronger than checking the DELETE status codes. Removing an
# address from client-emails is how a reader is REVOKED: the new allow policy is
# created without them and the old one that still grants them is deleted. If
# that delete does not take effect the revoked reader keeps reading, and the
# deploy used to go green anyway. A live app carries the fingerprint of exactly
# that — two identical managed allow policies created four seconds apart, i.e. a
# delete that reported success and did nothing, which a status check misses.
#
# Nothing to delete means no read-back and no extra API call.
if [ "${#INTENDED[@]}" -gt 0 ]; then
  if ! list_policies; then
    echo "::error::Could not re-read the Access policies after deleting, so the removal is unconfirmed — refusing to report a revocation we cannot see. Access is NOT reduced by this failure: the new policies were created before any delete and are live."
    exit 1
  fi
  INTENDED_JSON=$(printf '%s\n' "${INTENDED[@]}" | jq -R . | jq -sc .)
  SURVIVORS=$(jq -c --argjson ids "$INTENDED_JSON" \
    '[.[] | select(.id as $i | $ids | index($i))]' <<<"$LIST_RESULT")
  if [ "$(jq -r 'length' <<<"$SURVIVORS")" != "0" ]; then
    echo "::error::Policies this deploy deleted are STILL on the Access app: $(jq -r 'map("\"\(.name)\" (\(.id))") | join(", ")' <<<"$SURVIVORS"). Anyone they grant can still reach this KB, so any access this deploy meant to revoke has NOT been revoked. Remove them in the Cloudflare dashboard, then re-run."
    exit 1
  fi
  echo "Verified: ${#INTENDED[@]} old managed policy/policies confirmed gone from the app."
fi

echo "Policy sync complete."
