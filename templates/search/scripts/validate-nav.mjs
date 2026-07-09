#!/usr/bin/env node
// Deploy-time nav integrity check. Catches the class of breakage where the site
// menu points at pages that don't exist, or real pages silently drop out of the
// menu (e.g. an agent replacing the whole nav with an incomplete list). Covers
// both hand-authored HTML sites (docs/nav.json) and generator sites (mkdocs.yml).
//
// Emits FAIL:/WARN: lines like docs-lint.sh; the deploy workflow decides whether
// FAIL blocks the deploy (input nav-check: error|warn|off). Exit 1 iff any FAIL.
//
// FAIL  = a nav entry points at a page that doesn't exist (always wrong).
// WARN  = a page exists but isn't linked from the menu (orphan), or a duplicate
//         nav entry. Softer: some pages are intentionally unlinked.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseNavConfig, lintNav } from "./lib/nav.mjs";

const DOCS_DIR = process.env.DOCS_DIR || "docs";
const out = [];
const fail = (m) => out.push(`FAIL: ${m}`);
const warn = (m) => out.push(`WARN: ${m}`);

/** Recursively list files under `dir` ending in `ext`, returned dir-relative. */
function listFiles(dir, ext) {
  const results = [];
  const walk = (d, prefix) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), rel);
      else if (e.name.endsWith(ext)) results.push(rel);
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return results;
}

let checked = false;

// ── Hand-authored HTML sites: docs/nav.json ──────────────────────────────
const navJsonPath = join(DOCS_DIR, "nav.json");
if (existsSync(navJsonPath)) {
  checked = true;
  const config = parseNavConfig(readFileSync(navJsonPath, "utf8"));
  if (!config) {
    fail(`${navJsonPath} is not valid nav config JSON`);
  } else {
    const pages = listFiles(DOCS_DIR, ".html");
    // lintNav reports broken hrefs (nav -> missing page) and orphans (page not
    // in nav). A broken href is always a bug; an orphan is advisory.
    for (const e of lintNav(pages, config)) {
      if (e.includes("no matching page")) fail(e);
      else warn(e);
    }
  }
}

// ── Generator sites: mkdocs.yml / mkdocs.yaml ────────────────────────────
const PAGE_EXT = /\.(md|markdown|mdx|html?)$/i;

/** Extract the page path from a nav entry (the text after "- "): handles
 *  "Label: path", bare "path", quoted labels/paths, and trailing comments.
 *  Returns null for a dropdown parent or a non-page value. */
function navPathOf(entry) {
  let s = entry.replace(/\s+#.*$/, "").trim(); // strip inline comment
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1); // skip a quoted label (may contain a colon)
    if (end === -1) return null;
    const after = s.slice(end + 1);
    const c = after.indexOf(":");
    s = c === -1 ? "" : after.slice(c + 1).trim();
  } else if (s.includes(":")) {
    s = s.slice(s.indexOf(":") + 1).trim();
  }
  if (!s) return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  return s || null;
}

for (const yml of ["mkdocs.yml", "mkdocs.yaml"]) {
  if (!existsSync(yml)) continue;
  checked = true;
  const raw = readFileSync(yml, "utf8");
  // Validate nav paths against the mkdocs source dir (docs_dir), NOT the
  // workflow deploy-dir - mkdocs pages are .md under docs_dir, often built into
  // a different output dir.
  const mkDocsDir = (raw.match(/^docs_dir\s*:\s*(\S+)/m)?.[1] || "docs").replace(/["']/g, "");
  const lines = raw.split("\n");
  const navIdx = lines.findIndex((l) => /^nav\s*:/.test(l));
  if (navIdx === -1) continue; // no explicit nav: MkDocs auto-nav, nothing to check
  const navPaths = [];
  for (let i = navIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") continue;
    // Block ends at the next top-level key; a col-0 list item is still nav.
    if (/^\S/.test(l) && !/^-\s/.test(l)) break;
    const m = /^\s*-\s+(.*)$/.exec(l);
    if (!m) continue;
    const p = navPathOf(m[1]);
    // Skip dropdown parents, non-page values, and external links.
    if (!p || /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || p.startsWith("//") || p.startsWith("#")) continue;
    if (PAGE_EXT.test(p)) navPaths.push(p);
  }
  const seen = new Set();
  for (const p of navPaths) {
    if (seen.has(p)) warn(`mkdocs nav lists "${p}" more than once`);
    seen.add(p);
    if (!existsSync(join(mkDocsDir, p))) {
      fail(`mkdocs nav references a page that doesn't exist: ${p} (expected ${mkDocsDir}/${p})`);
    }
  }
  const targets = new Set(navPaths);
  for (const page of listFiles(mkDocsDir, ".md")) {
    if (!targets.has(page) && !/(^|\/)(index|404)\.md$/i.test(page)) {
      warn(`page not linked from the mkdocs nav (orphan): ${page}`);
    }
  }
}

if (!checked) {
  process.stdout.write("nav check: no nav.json or mkdocs.yml found (auto-nav) - skipped\n");
  process.exit(0);
}
for (const l of out) process.stdout.write(l + "\n");
if (!out.length) process.stdout.write("nav check: OK\n");
process.exit(out.some((l) => l.startsWith("FAIL:")) ? 1 : 0);
