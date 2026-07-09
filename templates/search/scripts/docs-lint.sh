#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# docs-lint.sh - run Glassdocs compliance checks against a repo.
#
# This is the same logic driven by .github/workflows/docs-lint.yml,
# extracted so it can be run locally and unit-tested in isolation.
#
# Usage (from a repo root):
#   docs-lint.sh                         # check ./docs, disallow financials
#   DOCS_DIR=documentation docs-lint.sh
#   ALLOW_FINANCIAL=true docs-lint.sh
#   ALLOW_INLINE_STYLES=true docs-lint.sh
#
# Exits non-zero when any hard check fails; prints each failure on its
# own line prefixed with FAIL:. Warnings are prefixed with WARN:.
# ──────────────────────────────────────────────────────────────────────
set -uo pipefail

DOCS_DIR="${DOCS_DIR:-docs}"
ALLOW_FINANCIAL="${ALLOW_FINANCIAL:-false}"
ALLOW_INLINE_STYLES="${ALLOW_INLINE_STYLES:-false}"

fails=0

fail() {
  echo "FAIL: $1"
  fails=$((fails + 1))
}

warn() {
  echo "WARN: $1"
}

# Helper: list tracked files, falling back to plain find when not a git
# repo (the fixture dirs in CI may not be git repos).
list_tracked() {
  local pattern="$1"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files "$pattern" 2>/dev/null
  else
    # shellcheck disable=SC2086
    # Expand glob patterns like "docs/*.html"
    local base="${pattern%%/*}"
    local rest="${pattern#*/}"
    if [ -d "$base" ]; then
      find "$base" -type f -name "$rest" 2>/dev/null | sort
    fi
  fi
}

tracked_file() {
  # Returns 0 if the file "exists" from the lint's perspective.
  # When inside a git repo, it must be git-tracked; otherwise file presence
  # is enough (for unit-testable fixtures).
  local path="$1"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files --error-unmatch "$path" >/dev/null 2>&1
  else
    [ -f "$path" ]
  fi
}

# 1. Workflow filename check
if [ -f .github/workflows/deploy.yml ]; then
  fail ".github/workflows/deploy.yml found - rename to docs-deploy.yml"
fi
if [ ! -f .github/workflows/docs-deploy.yml ]; then
  warn "No .github/workflows/docs-deploy.yml found"
fi

# 2. Brand assets must not be tracked in $DOCS_DIR/
for f in styles.css logo.svg favicon.svg robots.txt _headers nav.css; do
  if tracked_file "$DOCS_DIR/$f"; then
    fail "$DOCS_DIR/$f is tracked - brand assets are injected by deploy"
  fi
done

# 3. Publishing scripts must not live outside $DOCS_DIR/
if [ -d scripts ]; then
  stale=$(list_tracked "scripts/*" | grep -E '^scripts/(generate-|inject-page-meta|add-heading-ids|build-references)' || true)
  if [ -n "$stale" ]; then
    fail "Publishing scripts outside $DOCS_DIR/: $(echo "$stale" | tr '\n' ' ')"
  fi
fi

# 4. HTML pages must have robots noindex meta.
#    googlebot noindex is redundant when robots is set, so it's only a warning.
if [ -d "$DOCS_DIR" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if ! grep -q 'name="robots".*noindex' "$f"; then
      fail "$f missing robots noindex meta"
    fi
    if ! grep -q 'name="googlebot".*noindex' "$f"; then
      warn "$f missing googlebot noindex meta (optional; robots already covers this)"
    fi
  done < <(list_tracked "$DOCS_DIR/*.html")
fi

# 5. Pages with standard topbar must link shared styles.css AND favicon.
#    Standalone print-style pages are exempt: *-pdf.html filenames, or any
#    page with an @page CSS rule (indicates intentional print layout with
#    its own fully self-contained styling).
if [ -d "$DOCS_DIR" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      *-pdf.html) continue ;;
    esac
    if grep -q '@page' "$f" 2>/dev/null; then
      continue
    fi
    if grep -q '<header class="topbar"' "$f" 2>/dev/null; then
      if [ "$ALLOW_INLINE_STYLES" != "true" ]; then
        if ! grep -q 'href="styles.css"' "$f" 2>/dev/null \
           && ! grep -q 'href="/styles.css"' "$f" 2>/dev/null; then
          fail "$f uses standard topbar but does not link styles.css"
        fi
      fi
      if ! grep -q 'rel="icon"' "$f" 2>/dev/null; then
        fail "$f uses standard topbar but does not link favicon.svg"
      fi
    fi
    # Favicon, if present, must be a relative path
    if grep -qE 'rel="icon"[^>]*href="https?://' "$f" 2>/dev/null; then
      fail "$f references favicon via absolute URL"
    fi
  done < <(list_tracked "$DOCS_DIR/*.html")
fi

# 7. No commercial/contractual content unless explicitly allowed.
#    Effort-only artefacts (proposal.html, estimate.html, plan.html) are
#    legitimate KB content - work breakdowns and dev day estimates are
#    project planning, not commerce. Files that bind a dollar amount to
#    a deliverable (rate cards, pricing, quotes, invoices, contracts,
#    SOWs) belong in the pre-sales repo where allow-financial is set.
if [ "$ALLOW_FINANCIAL" != "true" ] && [ -d "$DOCS_DIR" ]; then
  bad=$(list_tracked "$DOCS_DIR/*" | grep -iE '(^|/)(sow|rate-card|pricing|quote|invoice|contract)[^/]*\.(html|pdf|docx)$' || true)
  if [ -n "$bad" ]; then
    fail "Commercial/contractual files in $DOCS_DIR/: $(echo "$bad" | tr '\n' ' ')"
  fi
fi

# 8. HTML class references should have CSS definitions somewhere.
#    Advisory only - runtime-composed classes and third-party markup can
#    trigger false positives, so this is a WARN not a FAIL.
#    Skips when the shared styles.css isn't available locally (it's
#    injected by the workflow during deploys; the CI run will have it).
if [ -d "$DOCS_DIR" ] && [ -f "$DOCS_DIR/styles.css" ] && command -v node >/dev/null 2>&1; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  CHECKER="$SCRIPT_DIR/check-undefined-classes.mjs"
  NAV_CSS="$SCRIPT_DIR/../../../templates/nav.css"
  if [ -f "$CHECKER" ]; then
    extra=""
    [ -f "$NAV_CSS" ] && extra="--extra-css $NAV_CSS"
    while IFS= read -r line; do
      [ -n "$line" ] && warn "$line"
    done < <(node "$CHECKER" --repo . $extra 2>/dev/null)
  fi
fi

if [ "$fails" -gt 0 ]; then
  echo "docs-lint: $fails violation(s)"
  exit 1
fi
echo "docs-lint: passed"
exit 0
