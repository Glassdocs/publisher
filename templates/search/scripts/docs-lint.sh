#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# docs-lint.sh - Glassdocs Markdown-KB compliance checks.
#
# A Glassdocs KB is Markdown: docs/*.md + mkdocs.yml, no custom HTML. The
# publisher builds it with Zensical (the MkDocs successor, which reads the
# KB's mkdocs.yml) and deploys the result. This lint enforces that shape before a deploy
# runs, so a non-conforming repo fails fast instead of mid-build.
#
# Usage (from a repo root):
#   docs-lint.sh                         # check ./docs
#   DOCS_DIR=documentation docs-lint.sh
#   ALLOW_FINANCIAL=true docs-lint.sh
#
# Exits non-zero when any hard check fails; prints each failure on its
# own line prefixed with FAIL:. Warnings are prefixed with WARN:.
# ──────────────────────────────────────────────────────────────────────
set -uo pipefail

DOCS_DIR="${DOCS_DIR:-docs}"
ALLOW_FINANCIAL="${ALLOW_FINANCIAL:-false}"

fails=0

fail() {
  echo "FAIL: $1"
  fails=$((fails + 1))
}

warn() {
  echo "WARN: $1"
}

# List tracked files matching a path prefix. Uses git when available so we
# only look at committed content; falls back to a plain find for the
# non-git fixture dirs used in unit tests.
list_under() {
  local dir="$1"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files "$dir" 2>/dev/null
  else
    [ -d "$dir" ] && find "$dir" -type f 2>/dev/null | sort
  fi
}

# 1. A KB must have a deploy workflow. Glassdocs standardises on
#    .github/workflows/deploy.yml (the platform scaffolds and dispatches it
#    by that name). docs-deploy.yml is the legacy name and still accepted.
if [ ! -f .github/workflows/deploy.yml ] && [ ! -f .github/workflows/docs-deploy.yml ]; then
  warn "No deploy workflow (.github/workflows/deploy.yml) found"
fi

# 2. A KB is Markdown — it MUST ship an mkdocs.yml the publisher can build.
if [ ! -f mkdocs.yml ]; then
  fail "No mkdocs.yml at repo root - a Glassdocs KB is Markdown (docs/*.md + mkdocs.yml)"
fi

# 3. The docs directory must be there to be checked. Checks 4 and 5 are both
#    guarded on `[ -d "$DOCS_DIR" ]`, so without this a missing directory took
#    neither branch: `fails` stayed 0, the script printed "docs-lint: passed",
#    and the deploy went green with BOTH hard checks silently skipped. That is
#    what a KB whose docs_dir isn't `docs` got from the publisher, which passed
#    DOCS_DIR=docs regardless (#152). A KB the lint could not look at is not a
#    KB that passed.
#
#    The same vacuous pass survives when the directory is THERE but git cannot
#    see into it — a gitignored, generated or submoduled docs dir. `[ -d ]`
#    is satisfied, `git ls-files` prints nothing and exits 0, and checks 4 and
#    5 look at an empty list (#172). Inside a work tree the lint therefore also
#    demands tracked content, using list_under so this check and the checks it
#    protects read the same source and cannot diverge. Outside a work tree
#    list_under falls back to `find`, and an empty dir there is a fixture
#    concern rather than a KB defect, so the demand does not apply.
if [ ! -d "$DOCS_DIR" ]; then
  fail "No $DOCS_DIR/ directory — set docs_dir in mkdocs.yml or move the Markdown"
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -z "$(list_under "$DOCS_DIR")" ]; then
  fail "$DOCS_DIR/ exists but has no committed files — the deploy would publish nothing and the checks below cannot run; commit the Markdown or check .gitignore"
fi

# 4. No custom HTML pages. Author in Markdown; mkdocs renders the HTML at
#    deploy time. A tracked *.html/*.htm anywhere under docs/ is a violation.
if [ -d "$DOCS_DIR" ]; then
  htmls=$(list_under "$DOCS_DIR" | grep -iE '\.html?$' || true)
  if [ -n "$htmls" ]; then
    fail "Custom HTML in $DOCS_DIR/ (Markdown only): $(echo "$htmls" | tr '\n' ' ')"
  fi
fi

# 5. No commercial/contractual content unless explicitly allowed.
#    Effort-only artefacts (proposal.md, estimate.md, plan.md) are legitimate
#    KB content - work breakdowns and dev-day estimates are project planning,
#    not commerce. Files that bind a dollar amount to a deliverable (rate
#    cards, pricing, quotes, invoices, contracts, SOWs) belong in the
#    pre-sales repo where allow-financial is set.
#
#    Match the commercial WORD as the filename stem (optionally pluralised or
#    with a numeric/date suffix like invoice-2024.pdf), NOT any file that merely
#    starts with it — so ordinary engineering docs (contract-testing.md,
#    pricing-model-architecture.md, quote-formatting.md) are not false-flagged.
if [ "$ALLOW_FINANCIAL" != "true" ] && [ -d "$DOCS_DIR" ]; then
  bad=$(list_under "$DOCS_DIR" | grep -iE '(^|/)(sow|rate-card|pricing|quote|invoice|contract)s?([-_ ]?[0-9][a-z0-9._-]*)?\.(md|pdf|docx)$' || true)
  if [ -n "$bad" ]; then
    fail "Commercial/contractual files in $DOCS_DIR/: $(echo "$bad" | tr '\n' ' ')"
  fi
fi

if [ "$fails" -gt 0 ]; then
  echo "docs-lint: $fails violation(s)"
  exit 1
fi
echo "docs-lint: passed"
exit 0
