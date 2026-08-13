#!/usr/bin/env node
// Inject GlassDocs recognition meta into a BUILT static site — post-build and
// build-agnostic, so it works on Zensical output (Zensical rewrote theming, so
// mkdocs-material `custom_dir` template overrides are a no-op; injection must
// happen here, after the build, not in the theme).
//
// The GlassDocs browser extension finds a KB via three meta tags in each page's
// <head> (see extension/src/resolver.ts):
//   <meta name="source-repo" content="owner/name">   — recognition (site-wide)
//   <meta name="source-path" content="docs/<file>.md"> — per-page edit target
//   <meta name="source-sha"  content="<blob sha>">     — the page VERSION (#94)
// source-path is a refinement (the resolver falls back to the URL), so a page
// without a clean source (e.g. 404.html) still gets source-repo and is
// recognised. source-sha is emitted only when the Markdown source is on disk.
//
// The same block also carries the ONE platform script a built KB gets:
//   <script defer src="/assets/glassdocs-read-aloud.js"></script>  — the in-page
// read-aloud control (#187), which is what lets a phone hear a KB page at all.
// It is in the block rather than beside it so a re-run replaces it instead of
// stacking a second copy; see READ_ALOUD_SRC below.
//
// WHY source-sha, and why THAT identifier: generated page audio is bound to the
// version of the page it was spoken from. A commit ref is the wrong key — a
// commit touching another file would invalidate every page's audio. The blob
// SHA is content-addressed, so an unrelated commit leaves an untouched page's
// identifier unmoved. It has to be the SAME identifier on both sides: the admin
// synthesises from Markdown (the GitHub tree API's blob sha, src/kb-docs.ts) and
// the reader compares against the rendered DOM, so a text hash computed here
// would never equal it. That is git's blob object id — SHA-1 over
// `blob <byte-length>\0<bytes>` — which is exactly what `git hash-object <file>`
// prints. Computed in JS rather than shelled out per page: one spawn per page is
// slow on a large KB, and a pure function is testable against real
// `git hash-object` output (extension/tests/inject-source-meta.test.mjs does
// precisely that rather than assuming the two agree).
//
// Usage: node inject-source-meta.mjs --repo OWNER/NAME --site DIR [--docs-dir docs]
//
// Bails (warning, exit 0) if --repo is missing/invalid so a deploy never fails
// on this — the site still ships, the extension's write features just stay off.
// Idempotent: a re-run replaces its own <!-- @glassdocs-meta --> block.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const START = "<!-- @glassdocs-meta -->";
const END = "<!-- /@glassdocs-meta -->";

function parseArgs(argv) {
  const o = { repo: null, site: "site", docsDir: "docs" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") o.repo = argv[++i];
    else if (a === "--site") o.site = argv[++i];
    else if (a === "--docs-dir") o.docsDir = argv[++i];
  }
  return o;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (e.endsWith(".html")) out.push(p);
  }
  return out;
}

// Reverse the generator's directory-URL mapping to the Markdown source:
//   site/index.html        -> docs/index.md
//   site/foo/index.html    -> docs/foo.md  OR  docs/foo/index.md (section landing)
//   site/a/b/index.html    -> docs/a/b.md  OR  docs/a/b/index.md
//   site/404.html (non-index) -> null (no clean source; source-repo only)
//
// `site/foo/index.html` is ambiguous: MkDocs/Zensical produce it from EITHER
// `docs/foo.md` OR the common section-landing file `docs/foo/index.md`.
//
// EVERY candidate is probed, and null is returned when none is on disk. It used
// to probe only the section landing and then return the flat path unchecked (and
// the root `index.html` unchecked as well), so a KB whose docs_dir isn't `docs`
// had every page stamped with a `docs/<x>.md` that does not exist: "Edit this"
// then committed a NEW file under docs/, which the build never reads, so the
// change published nothing and the repo accumulated stray Markdown outside its
// own docs tree (#152). An ABSENT source-path is fine — the resolver falls back
// to the URL, already the documented behaviour for 404.html — while a present
// one is taken at face value. Same reasoning as source-sha above: no answer
// beats a confident wrong one.
//
// The build ran in the checked-out repo, so the docs tree is on disk (`exists`
// is injectable for tests).
export function sourcePathFor(file, siteDir, docsDir, exists = existsSync) {
  const rel = path.relative(siteDir, file).split(path.sep).join("/");
  let candidates;
  if (rel === "index.html") {
    candidates = [`${docsDir}/index.md`];
  } else {
    const m = rel.match(/^(.+)\/index\.html$/);
    if (!m) return null;
    // Section landing first: it is the one that, guessed wrong, creates a stray
    // sibling of a directory that already has an index.
    candidates = [`${docsDir}/${m[1]}/index.md`, `${docsDir}/${m[1]}.md`];
  }
  return candidates.find((c) => exists(c)) ?? null;
}

// git's blob object id for the given bytes: SHA-1 over `blob <len>\0<content>`.
// Byte-exact and encoding-agnostic — take a Buffer, never a decoded string, or a
// CRLF/BOM/UTF-8 page would hash differently from what git (and therefore the
// GitHub tree API) reports.
export function gitBlobSha(buf) {
  const header = Buffer.from(`blob ${buf.length}\0`, "utf8");
  return createHash("sha1").update(Buffer.concat([header, buf])).digest("hex");
}

// The blob sha of a page's Markdown source, or null when there is no source on
// disk (404.html, or a page whose source was resolved to a file that doesn't
// exist). Null means "version unknown" and simply omits the meta tag: an absent
// source-sha makes the reader fall back, whereas a wrong one would let it play
// audio for a page that has since changed.
export function sourceShaFor(sourcePath, read = readFileSync) {
  if (!sourcePath) return null;
  try {
    return gitBlobSha(read(sourcePath));
  } catch {
    return null;
  }
}

// The in-page read-aloud control (#187), copied to this path by the deploy
// workflow's "Add the in-page read-aloud control" step. It lives INSIDE the
// @glassdocs-meta block so a re-run replaces it along with everything else,
// rather than accumulating a second <script> tag on every rebuild.
//
// `defer` is required, not tidiness: the block is inserted immediately before
// </head>, so a blocking script would stall the parse of every page, and — worse
// — would run before the DOM it reads and inserts itself into exists.
//
// Same-origin, so `script-src 'self'` in templates/_headers already permits it;
// no CSP change is needed and none may be made.
const READ_ALOUD_SRC = "/assets/glassdocs-read-aloud.js";

// Insert (or replace) the meta block just before </head>. Returns the new HTML,
// or null when there is no <head> to inject into.
export function injectInto(html, repo, sourcePath, sourceSha) {
  // Strip exactly what this function inserted, and nothing else: the block's own
  // indent (`[ \t]*`, horizontal only) and its own closing newline (`\n?`, see
  // `block` below). That precision is the whole fixed-point property.
  //
  // Both halves were learned the hard way, in two passes:
  //
  //   078ec79 had `\s*${START}…${END}` — no trailing `\n?`. The strip ate the
  //   whitespace BEFORE the block but left the newline after it, so each run
  //   pushed the block one line further down and the page grew a newline per
  //   deploy, stabilising only on run three.
  //
  //   4e0112f added the `\n?` and fixed that growth, but left the leading `\s*`
  //   in place — and `\s` matches newlines. So the strip then ate the document's
  //   OWN line break before the block as well as the block's indent, and run two
  //   came back one byte SHORTER than run one (303 → 302 on the fixture below),
  //   stabilising on run two. Bounded, so the growth was genuinely gone, but the
  //   function still was not the fixed point this header promises.
  //
  // Why the second pass shipped looking complete: every fixed-point test then in
  // the tree used a single-line fixture, where there is no line break before
  // </head> for `\s*` to eat. The bug is invisible on such a page and certain on
  // any real Zensical output. Measured on 4e0112f across 5 page shapes × 3
  // argument shapes: 9 of 15 combinations were not fixed points — every shape
  // with whitespace before </head> (multiline, tab-indented, uppercase </HEAD>).
  // extension/tests/inject-source-meta.test.mjs now pins a multiline fixture so
  // that class of vacuous pass cannot return.
  const stripped = html.replace(new RegExp(`[ \\t]*${START}[\\s\\S]*?${END}\\n?`, "g"), "");
  const headClose = stripped.search(/<\/head>/i);
  if (headClose === -1) return null;
  const block =
    `  ${START}\n` +
    `  <meta name="source-repo" content="${escapeAttr(repo)}">\n` +
    (sourcePath ? `  <meta name="source-path" content="${escapeAttr(sourcePath)}">\n` : "") +
    (sourcePath && sourceSha ? `  <meta name="source-sha" content="${escapeAttr(sourceSha)}">\n` : "") +
    `  <script defer src="${READ_ALOUD_SRC}"></script>\n` +
    `  ${END}\n`;
  return stripped.slice(0, headClose) + block + stripped.slice(headClose);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo || !/^[^/\s]+\/[^/\s]+$/.test(args.repo)) {
    console.warn(
      "inject-source-meta: no valid --repo OWNER/NAME — skipping. The site still deploys; the GlassDocs extension's write features stay off until a repo is set.",
    );
    return;
  }
  const files = htmlFiles(args.site);
  let injected = 0;
  let versioned = 0;
  // The build ran in the checked-out repo, so each page's Markdown is on disk
  // and can be hashed once. Cache by source path: section landings map several
  // built pages to one source on some layouts.
  const shaCache = new Map();
  for (const f of files) {
    const sourcePath = sourcePathFor(f, args.site, args.docsDir);
    let sha = null;
    if (sourcePath) {
      if (!shaCache.has(sourcePath)) shaCache.set(sourcePath, sourceShaFor(sourcePath));
      sha = shaCache.get(sourcePath);
    }
    const out = injectInto(readFileSync(f, "utf8"), args.repo, sourcePath, sha);
    if (out == null) continue; // no <head>
    writeFileSync(f, out);
    injected++;
    if (sha) versioned++;
  }
  console.log(
    `inject-source-meta: source-repo=${args.repo} into ${injected}/${files.length} page(s); ` +
      `source-sha on ${versioned}.`,
  );
}

// Run only as a CLI (keep the helpers importable for tests).
if (import.meta.url === `file://${process.argv[1]}`) main();
