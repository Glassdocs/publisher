// ──────────────────────────────────────────────────────────────────────
// docs-lint.sh — the gate that blocks a deploy before any side effect.
//
// The distinction that matters is HARD FAIL (exit 1, deploy blocked) vs WARN
// (exit 0, deploy proceeds). Promoting a warn to a fail breaks every KB that
// hasn't adopted the new file yet; demoting a fail to a warn ships a
// non-conforming KB. Each test names which side of that line it pins.
// ──────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { runLint, fixtureTree, isGitRepo } from "./helpers/harness.mjs";

const MKDOCS = "site_name: Test KB\n";
const WORKFLOW = "name: deploy\non: push\njobs: {}\n";

/** A minimal conforming KB, plus whatever extra files a test adds. */
function kb(extra = {}) {
  return {
    "mkdocs.yml": MKDOCS,
    ".github/workflows/deploy.yml": WORKFLOW,
    "docs/index.md": "# Home\n",
    ...extra,
  };
}

function lint(files, { env = {}, git = true } = {}) {
  const dir = fixtureTree(files, { git });
  const res = runLint(dir, env);
  return { ...res, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── Baseline ──────────────────────────────────────────────────────────

test("a conforming Markdown KB passes with no failures and no warnings", (t) => {
  const r = lint(kb());
  t.after(r.cleanup);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /docs-lint: passed/);
  assert.doesNotMatch(r.out, /^FAIL:/m);
  assert.doesNotMatch(r.out, /^WARN:/m);
});

// ── Hard fails: these block the deploy ────────────────────────────────

test("HARD FAIL: a missing mkdocs.yml blocks the deploy (a KB is Markdown)", (t) => {
  const files = kb();
  delete files["mkdocs.yml"];
  const r = lint(files);
  t.after(r.cleanup);

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^FAIL: No mkdocs\.yml at repo root/m);
});

// ── The docs directory must be THERE, and visible to git (#152, #172) ──
//
// Checks 4 and 5 are both guarded on `[ -d "$DOCS_DIR" ]`. Without check 3 a
// missing — or git-invisible — docs dir took neither branch: `fails` stayed 0,
// the script printed "docs-lint: passed", and the deploy went green with BOTH
// hard checks silently skipped. A KB the lint could not look at is not a KB that
// passed, and these tests are the only thing standing between that sentence and
// a vacuous green. Each asserts the FAIL, then re-asserts that the pass line is
// absent — because the bug's signature was a pass, not a wrong failure.

test("HARD FAIL: no docs/ directory at all blocks the deploy (#152)", (t) => {
  const files = kb();
  delete files["docs/index.md"]; // nothing else puts docs/ on disk
  const r = lint(files);
  t.after(r.cleanup);

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^FAIL: No docs\/ directory/m);
  assert.doesNotMatch(r.out, /docs-lint: passed/, "a lint that could not look at the KB must not report a pass");
});

test("HARD FAIL: docs/ exists but nothing in it is tracked — gitignored or generated (#172)", (t) => {
  // `[ -d ]` is satisfied and `git ls-files` prints nothing and exits 0, so
  // checks 4 and 5 would look at an empty list and pass vacuously. Stage
  // everything EXCEPT the Markdown to reproduce that exactly.
  const files = kb();
  const r = lint(files, { git: { "mkdocs.yml": 1, ".github/workflows/deploy.yml": 1 } });
  t.after(r.cleanup);

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^FAIL: docs\/ exists but has no committed files/m);
  assert.doesNotMatch(r.out, /docs-lint: passed/);
});

test("HARD FAIL: an untracked docs/ hides a violation that would otherwise block — and is caught anyway (#172)", (t) => {
  // The reason #172 matters rather than being a tidiness point: the same blind
  // spot that skipped the checks also concealed real violations. Custom HTML
  // under an untracked docs/ used to deploy green.
  const files = kb({ "docs/custom.html": "<h1>hand-written</h1>" });
  const r = lint(files, { git: { "mkdocs.yml": 1, ".github/workflows/deploy.yml": 1 } });
  t.after(r.cleanup);

  assert.equal(r.status, 1, r.out);
  assert.doesNotMatch(r.out, /docs-lint: passed/);
});

test("HARD FAIL: the missing-directory check follows DOCS_DIR, not a hardcoded docs/", (t) => {
  // The #152 case in its original form: the publisher passed DOCS_DIR=docs
  // regardless, so a docs_dir: content KB was linted against a directory that
  // was never there.
  const files = kb();
  delete files["docs/index.md"];
  files["content/index.md"] = "# Home\n";
  const r = lint(files, { env: { DOCS_DIR: "content" } });
  t.after(r.cleanup);

  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /docs-lint: passed/);
});

test("a tracked-content demand does NOT apply outside a git work tree (the carve-out is deliberate)", (t) => {
  // list_under falls back to `find` there, so an empty dir is a fixture concern
  // rather than a KB defect. Pinning this stops a future tightening from
  // breaking the non-git path by accident.
  const dir = fixtureTree(kb(), { git: false });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(isGitRepo(dir), false, "fixture must not be inside a git work tree");

  const res = runLint(dir);
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /docs-lint: passed/);
});

test("HARD FAIL: tracked HTML under docs/ blocks the deploy", (t) => {
  const r = lint(kb({ "docs/custom.html": "<h1>hand-written</h1>" }));
  t.after(r.cleanup);

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^FAIL: Custom HTML in docs\/.*custom\.html/m);
});

test("HARD FAIL: a .htm (not just .html) under docs/ blocks the deploy", (t) => {
  const r = lint(kb({ "docs/legacy.HTM": "<h1>x</h1>" }));
  t.after(r.cleanup);

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^FAIL: Custom HTML in docs\//m);
});

test("UNTRACKED HTML under docs/ does not block the deploy (only committed content is linted)", (t) => {
  // Built output and local scratch files land in the working tree constantly;
  // linting them would fail every deploy that ran a local build first.
  const dir = fixtureTree(kb(), { git: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Written AFTER staging, so git never sees it.
  writeFileSync(`${dir}/docs/scratch.html`, "<h1>local build artefact</h1>");

  const res = runLint(dir);
  assert.equal(res.status, 0, res.out);
  assert.doesNotMatch(res.out, /Custom HTML/);
});

test("HARD FAIL: commercial filenames under docs/ block the deploy", (t) => {
  for (const name of [
    "pricing.md",
    "quote.md",
    "quotes.md",
    "invoice.pdf",
    "invoice-2024.pdf",
    "contract.docx",
    "sow.md",
    "rate-card.md",
    "nested/deep/pricing.md",
  ]) {
    const r = lint(kb({ [`docs/${name}`]: "x" }));
    assert.equal(r.status, 1, `${name} should be a hard fail; output: ${r.out}`);
    assert.match(r.out, /^FAIL: Commercial\/contractual files/m, name);
    r.cleanup();
  }
});

// ── Warnings: these must NOT block the deploy ─────────────────────────

test("WARN ONLY: a missing deploy workflow warns but still deploys", (t) => {
  const files = kb();
  delete files[".github/workflows/deploy.yml"];
  const r = lint(files);
  t.after(r.cleanup);

  assert.equal(r.status, 0, `a missing workflow must not block a deploy: ${r.out}`);
  assert.match(r.out, /^WARN: No deploy workflow/m);
  assert.match(r.out, /docs-lint: passed/);
});

test("the legacy docs-deploy.yml workflow name is still accepted without a warning", (t) => {
  const files = kb();
  delete files[".github/workflows/deploy.yml"];
  files[".github/workflows/docs-deploy.yml"] = WORKFLOW;
  const r = lint(files);
  t.after(r.cleanup);

  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /^WARN: No deploy workflow/m);
});

// ── Exemptions ────────────────────────────────────────────────────────

test("ALLOW_FINANCIAL=true exempts commercial filenames (the pre-sales KB case)", (t) => {
  const r = lint(kb({ "docs/pricing.md": "x", "docs/sow.md": "x" }), { env: { ALLOW_FINANCIAL: "true" } });
  t.after(r.cleanup);

  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /Commercial/);
});

test("ALLOW_FINANCIAL only exempts on the exact string 'true' — no accidental opt-out", (t) => {
  for (const value of ["", "false", "TRUE", "1", "yes"]) {
    const r = lint(kb({ "docs/pricing.md": "x" }), { env: { ALLOW_FINANCIAL: value } });
    assert.equal(r.status, 1, `ALLOW_FINANCIAL=${JSON.stringify(value)} must not exempt: ${r.out}`);
    r.cleanup();
  }
});

test("effort artefacts (proposal/estimate/plan) are legitimate KB content, not commerce", (t) => {
  const r = lint(kb({ "docs/proposal.md": "x", "docs/estimate.md": "x", "docs/plan.md": "x" }));
  t.after(r.cleanup);

  assert.equal(r.status, 0, `project-planning docs must not be flagged: ${r.out}`);
  assert.doesNotMatch(r.out, /Commercial/);
});

test("engineering docs whose names merely START with a commercial word are not false-flagged", (t) => {
  const r = lint(
    kb({
      "docs/contract-testing.md": "x",
      "docs/pricing-model-architecture.md": "x",
      "docs/quote-formatting.md": "x",
      "docs/invoicing-service-design.md": "x",
      "docs/sowing-seeds.md": "x",
    }),
  );
  t.after(r.cleanup);

  assert.equal(r.status, 0, `false positives would block real KBs: ${r.out}`);
  assert.doesNotMatch(r.out, /Commercial/);
});

test("commercial files OUTSIDE docs/ are ignored (the lint scopes to the published tree)", (t) => {
  const r = lint(kb({ "internal/pricing.md": "x", "invoice.pdf": "x" }));
  t.after(r.cleanup);
  assert.equal(r.status, 0, r.out);
});

test("DOCS_DIR redirects both the HTML and the commercial check", (t) => {
  const files = kb({ "documentation/custom.html": "<h1>x</h1>", "documentation/pricing.md": "x" });
  delete files["docs/index.md"];
  const r = lint(files, { env: { DOCS_DIR: "documentation" } });
  t.after(r.cleanup);

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Custom HTML in documentation\//);
  assert.match(r.out, /Commercial\/contractual files in documentation\//);
});

// ── Reporting contract with the workflow ──────────────────────────────

test("multiple violations are all reported and counted, not just the first", (t) => {
  const files = kb({ "docs/custom.html": "<h1>x</h1>", "docs/pricing.md": "x" });
  delete files["mkdocs.yml"];
  const r = lint(files);
  t.after(r.cleanup);

  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /docs-lint: 3 violation\(s\)/);
});

test("every failure line is prefixed FAIL: and every warning WARN: (the workflow maps these to annotations)", (t) => {
  const files = kb({ "docs/pricing.md": "x" });
  delete files["mkdocs.yml"];
  delete files[".github/workflows/deploy.yml"];
  const r = lint(files);
  t.after(r.cleanup);

  const lines = r.stdout.split("\n").filter(Boolean);
  const annotated = lines.filter((l) => /^(FAIL|WARN): /.test(l));
  assert.equal(annotated.length, 3, `unprefixed diagnostics lose their annotation: ${r.out}`);
  assert.equal(lines.filter((l) => l.startsWith("WARN: ")).length, 1);
});

// ── Non-git fallback ──────────────────────────────────────────────────

test("outside a git work tree the lint falls back to a filesystem walk", (t) => {
  const dir = fixtureTree(kb({ "docs/custom.html": "<h1>x</h1>" }), { git: false });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Guard the premise: if the temp dir were inside a repo this would be
  // testing the git path instead and silently prove nothing.
  assert.equal(isGitRepo(dir), false, "fixture must not be inside a git work tree");

  const res = runLint(dir);
  assert.equal(res.status, 1, res.out);
  assert.match(res.out, /Custom HTML/);
});
