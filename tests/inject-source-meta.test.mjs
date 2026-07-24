// ──────────────────────────────────────────────────────────────────────
// inject-source-meta.mjs — stamps the built site with the two meta tags the
// browser extension needs. Two failure modes matter: injecting badly (breaking
// the page or pointing "edit this page" at a file that doesn't exist, which
// creates a stray file on commit), and failing loudly (this step must never
// take down a deploy — the site ships, the write features just stay off).
// ──────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fixtureTree, runInject, INJECT_SCRIPT } from "./helpers/harness.mjs";
import { injectInto, sourcePathFor } from "../templates/search/scripts/inject-source-meta.mjs";

const PAGE = `<!DOCTYPE html>
<html><head>
<title>Doc</title>
</head><body><h1>Hi</h1></body></html>`;

// ── injectInto ────────────────────────────────────────────────────────

test("the meta block is inserted immediately before </head>, not after it", () => {
  const out = injectInto(PAGE, "acme/kb", "docs/index.md");
  const metaAt = out.indexOf('name="source-repo"');
  const headAt = out.indexOf("</head>");
  assert.ok(metaAt !== -1, "source-repo meta missing");
  assert.ok(metaAt < headAt, "meta must land inside <head>");
  assert.ok(out.indexOf("<body>") > headAt, "the body must be left untouched");
});

test("both meta tags carry the values the extension resolver reads", () => {
  const out = injectInto(PAGE, "acme/kb", "docs/guides/setup.md");
  assert.match(out, /<meta name="source-repo" content="acme\/kb">/);
  assert.match(out, /<meta name="source-path" content="docs\/guides\/setup\.md">/);
});

test("a page with no clean Markdown source still gets source-repo (so the site stays recognised)", () => {
  const out = injectInto(PAGE, "acme/kb", null);
  assert.match(out, /name="source-repo"/);
  assert.doesNotMatch(out, /name="source-path"/, "a guessed source-path would create stray files on commit");
});

test("re-running is idempotent: the block is replaced, never duplicated", () => {
  const once = injectInto(PAGE, "acme/kb", "docs/index.md");
  const twice = injectInto(once, "acme/kb", "docs/index.md");
  assert.equal(twice, once, "a second pass must be a no-op");
  assert.equal(twice.match(/name="source-repo"/g).length, 1);
});

test("re-running with a NEW repo replaces the old value rather than appending a second one", () => {
  const once = injectInto(PAGE, "old/kb", "docs/index.md");
  const twice = injectInto(once, "new/kb", "docs/index.md");
  assert.match(twice, /content="new\/kb"/);
  assert.doesNotMatch(twice, /old\/kb/);
  assert.equal(twice.match(/name="source-repo"/g).length, 1);
});

test("a page with no <head> is skipped instead of being corrupted", () => {
  assert.equal(injectInto("<html><body>fragment</body></html>", "acme/kb", null), null);
});

test("an uppercase </HEAD> is still recognised", () => {
  const out = injectInto("<html><HEAD></HEAD><body></body></html>", "acme/kb", null);
  assert.ok(out !== null);
  assert.ok(out.indexOf('name="source-repo"') < out.indexOf("</HEAD>"));
});

test("attribute values are escaped so a crafted repo name cannot break out of the tag", () => {
  const out = injectInto(PAGE, 'a"><script>alert(1)</script>/b', "docs/index.md");
  assert.doesNotMatch(out, /<script>/, "a quote in the repo name must not escape the attribute");
  assert.match(out, /&quot;/);
});

// ── sourcePathFor ─────────────────────────────────────────────────────

const never = () => false;
const always = () => true;

test("site/index.html maps to the docs root index", () => {
  assert.equal(sourcePathFor("site/index.html", "site", "docs", never), "docs/index.md");
});

test("site/foo/index.html prefers docs/foo/index.md when that section landing file exists", () => {
  assert.equal(sourcePathFor("site/foo/index.html", "site", "docs", always), "docs/foo/index.md");
});

test("site/foo/index.html falls back to docs/foo.md when there is no section landing file", () => {
  assert.equal(sourcePathFor("site/foo/index.html", "site", "docs", never), "docs/foo.md");
});

test("nested pages keep their full path", () => {
  assert.equal(sourcePathFor("site/a/b/index.html", "site", "docs", never), "docs/a/b.md");
  assert.equal(sourcePathFor("site/a/b/index.html", "site", "docs", always), "docs/a/b/index.md");
});

test("a non-index page such as 404.html has no Markdown source", () => {
  assert.equal(sourcePathFor("site/404.html", "site", "docs", never), null);
  assert.equal(sourcePathFor("site/deep/search.html", "site", "docs", never), null);
});

test("a custom docs dir is honoured in the mapped source path", () => {
  assert.equal(sourcePathFor("site/foo/index.html", "site", "documentation", never), "documentation/foo.md");
});

test("the existence probe is asked about the SECTION landing file, not the flat file", () => {
  const asked = [];
  sourcePathFor("site/guides/index.html", "site", "docs", (p) => {
    asked.push(p);
    return false;
  });
  assert.deepEqual(asked, ["docs/guides/index.md"]);
});

// ── CLI end to end ────────────────────────────────────────────────────

function site(extra = {}) {
  return fixtureTree({
    "docs/index.md": "# Home\n",
    "docs/guides/index.md": "# Guides\n",
    "docs/about.md": "# About\n",
    "site/index.html": PAGE,
    "site/about/index.html": PAGE,
    "site/guides/index.html": PAGE,
    "site/404.html": PAGE,
    ...extra,
  });
}

function readSite(dir, rel) {
  return readFileSync(path.join(dir, "site", rel), "utf8");
}

test("the CLI injects the right source path into every built page", (t) => {
  const dir = site();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const res = runInject(dir, ["--repo", "acme/kb", "--site", "site", "--docs-dir", "docs"]);
  assert.equal(res.status, 0, res.out);

  assert.match(readSite(dir, "index.html"), /source-path" content="docs\/index\.md"/);
  assert.match(readSite(dir, "about/index.html"), /source-path" content="docs\/about\.md"/);
  // guides/ has a real docs/guides/index.md, so the section landing file wins.
  assert.match(readSite(dir, "guides/index.html"), /source-path" content="docs\/guides\/index\.md"/);
  assert.match(readSite(dir, "404.html"), /source-repo" content="acme\/kb"/);
  assert.doesNotMatch(readSite(dir, "404.html"), /source-path/);
  assert.match(res.out, /4\/4 page\(s\)/);
});

test("running the CLI twice leaves the site byte-identical", (t) => {
  const dir = site();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const args = ["--repo", "acme/kb", "--site", "site", "--docs-dir", "docs"];
  runInject(dir, args);
  const after1 = readSite(dir, "index.html");
  runInject(dir, args);
  assert.equal(readSite(dir, "index.html"), after1, "a rebuild+reinject must not accumulate blocks");
});

for (const [label, repo] of [
  ["no owner separator", "notaslug"],
  ["three segments", "owner/name/extra"],
  ["an empty value", ""],
  ["a bare slash", "/"],
  ["whitespace in the slug", "own er/name"],
]) {
  test(`a malformed --repo (${label}) skips injection, leaves files untouched, and still exits 0`, (t) => {
    const dir = site();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const before = readSite(dir, "index.html");

    const res = runInject(dir, ["--repo", repo, "--site", "site", "--docs-dir", "docs"]);

    assert.equal(res.status, 0, `a bad repo slug must never fail the deploy: ${res.out}`);
    assert.match(res.out, /skipping/);
    assert.equal(readSite(dir, "index.html"), before, "no file may be rewritten when the repo is unusable");
  });
}

test("a missing --repo flag entirely skips injection and still exits 0", (t) => {
  const dir = site();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const before = readSite(dir, "index.html");

  const res = runInject(dir, ["--site", "site", "--docs-dir", "docs"]);

  assert.equal(res.status, 0, res.out);
  assert.equal(readSite(dir, "index.html"), before);
});

test("importing the module for tests does not run the CLI", (t) => {
  // Guarded by the `import.meta.url === process.argv[1]` check; if that broke,
  // importing the module above would have tried to walk ./site and thrown.
  assert.equal(typeof injectInto, "function");
  assert.ok(INJECT_SCRIPT.endsWith("inject-source-meta.mjs"));
});
