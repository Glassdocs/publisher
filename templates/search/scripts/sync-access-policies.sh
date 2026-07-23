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
  IFS=',' read -ra _emails <<< "$CLIENT_EMAILS"
  for e in "${_emails[@]}"; do
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
  IFS=',' read -ra _cidrs <<< "$OFFICE_CIDRS"
  for c in "${_cidrs[@]}"; do
    c_trim=$(trim "$c")
    [ -z "$c_trim" ] && continue
    # Both address families: Cloudflare Access ip includes accept IPv4 and
    # IPv6 CIDRs (and bare IPs), and IPv6 office ranges predate this check —
    # rejecting them would hard-fail every deploy for those tenants.
    if [[ "$c_trim" == *:* ]]; then
      if [[ ! "$c_trim" =~ ^[0-9A-Fa-f:]+(/[0-9]+)?$ ]]; then
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
EXISTING='[]'
PAGE=1
while true; do
  RESP=$("$CURL" -sS "${BASE}/apps/${APP_ID}/policies?page=${PAGE}&per_page=50" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
  if [ "$(jq -r '.success // false' <<<"$RESP")" != "true" ]; then
    echo "::error::Failed to list policies (page ${PAGE})"
    jq -r '.errors // [] | .[] | "  code=\(.code) message=\(.message)"' <<<"$RESP" >&2
    exit 1
  fi
  PAGE_RESULT=$(jq -c '.result // []' <<<"$RESP")
  EXISTING=$(jq -c --argjson page "$PAGE_RESULT" '. + $page' <<<"$EXISTING")
  COUNT=$(jq -r 'length' <<<"$PAGE_RESULT")
  TOTAL_PAGES=$(jq -r '.result_info.total_pages // 1' <<<"$RESP")
  if [ "$PAGE" -ge "$TOTAL_PAGES" ] || [ "$COUNT" = "0" ]; then
    break
  fi
  PAGE=$((PAGE + 1))
done

echo "Existing policies:"
jq -r '.[] | "  \(.id) prec=\(.precedence) \(.name)"' <<<"$EXISTING"

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

# ── Only now delete the OLD policies (every create above succeeded) ──
OLD_IDS=$(jq -r '.[].id' <<<"$EXISTING")
for pid in $OLD_IDS; do
  pname=$(jq -r --arg id "$pid" '.[] | select(.id==$id) | .name' <<<"$EXISTING")
  echo "Deleting old policy: $pname ($pid)"
  del_resp=$("$CURL" -sS -X DELETE \
    "${BASE}/apps/${APP_ID}/policies/${pid}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}")
  if [ "$(jq -r '.success // false' <<<"$del_resp")" != "true" ]; then
    echo "::warning::Failed to delete old policy $pname ($pid): $(jq -r '.errors[0].message // "unknown"' <<<"$del_resp"). It remains on the app alongside the new policies — remove it manually if unwanted (it may be an undeletable reusable policy)."
  fi
done

echo "Policy sync complete."
