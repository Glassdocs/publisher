#!/usr/bin/env node
// Inject GlassDocs recognition meta into a BUILT static site — post-build and
// build-agnostic, so it works on Zensical output (Zensical rewrote theming, so
// mkdocs-material `custom_dir` template overrides are a no-op; injection must
// happen here, after the build, not in the theme).
//
// The GlassDocs browser extension finds a KB via two meta tags in each page's
// <head> (see extension/src/resolver.ts):
//   <meta name="source-repo" content="owner/name">   — recognition (site-wide)
//   <meta name="source-path" content="docs/<file>.md"> — per-page edit target
// source-path is a refinement (the resolver falls back to the URL), so a page
// without a clean source (e.g. 404.html) still gets source-repo and is
// recognised.
//
// Usage: node inject-source-meta.mjs --repo OWNER/NAME --site DIR [--docs-dir docs]
//
// Bails (warning, exit 0) if --repo is missing/invalid so a deploy never fails
// on this — the site still ships, the extension's write features just stay off.
// Idempotent: a re-run replaces its own <!-- @glassdocs-meta --> block.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
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
//   site/foo/index.html    -> docs/foo.md
//   site/a/b/index.html    -> docs/a/b.md
//   site/404.html (non-index) -> null (no clean source; source-repo only)
export function sourcePathFor(file, siteDir, docsDir) {
  const rel = path.relative(siteDir, file).split(path.sep).join("/");
  if (rel === "index.html") return `${docsDir}/index.md`;
  const m = rel.match(/^(.+)\/index\.html$/);
  return m ? `${docsDir}/${m[1]}.md` : null;
}

// Insert (or replace) the meta block just before </head>. Returns the new HTML,
// or null when there is no <head> to inject into.
export function injectInto(html, repo, sourcePath) {
  const stripped = html.replace(new RegExp(`\\s*${START}[\\s\\S]*?${END}`, "g"), "");
  const headClose = stripped.search(/<\/head>/i);
  if (headClose === -1) return null;
  const block =
    `  ${START}\n` +
    `  <meta name="source-repo" content="${escapeAttr(repo)}">\n` +
    (sourcePath ? `  <meta name="source-path" content="${escapeAttr(sourcePath)}">\n` : "") +
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
  for (const f of files) {
    const out = injectInto(readFileSync(f, "utf8"), args.repo, sourcePathFor(f, args.site, args.docsDir));
    if (out == null) continue; // no <head>
    writeFileSync(f, out);
    injected++;
  }
  console.log(`inject-source-meta: source-repo=${args.repo} into ${injected}/${files.length} page(s).`);
}

// Run only as a CLI (keep the helpers importable for tests).
if (import.meta.url === `file://${process.argv[1]}`) main();
