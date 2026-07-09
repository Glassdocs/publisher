#!/usr/bin/env node
// Check for HTML class references that have no CSS definition.
//
// Scans every *.html page in docs/, collects class names used in `class="..."`
// attributes, and compares against classes defined in:
//   - docs/styles.css (shared, injected by workflow)
//   - Inline <style> blocks on the same page
//   - Known always-present state modifiers (active, open, past, ...)
//   - nav.css if injected
//
// Any class left over is likely a bug: either a typo, or a page that used to
// have inline CSS that got stripped during a migration.
//
// Skips JavaScript template literals like class="cell-${s}" (runtime-composed).
//
// Prints each undefined class on its own line; exits 0 always (intended as
// an advisory check in the lint pipeline).
//
// Usage:
//   node check-undefined-classes.mjs                 # auto-detect repo root
//   node check-undefined-classes.mjs --repo PATH     # explicit repo root
//   node check-undefined-classes.mjs --extra-css /path/to/nav.css

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// Classes that are state modifiers, always-present utility names, or
// injected by JS / Pagefind / third-party libraries. Never warn on these.
export const SAFE = new Set([
  // State modifiers applied dynamically to shared components
  'active', 'open', 'past', 'today', 'future',
  'done', 'pending', 'blocked', 'not-started',
  // Severity variants commonly paired with .card, .verdict, .status, .check
  'highlight', 'warning', 'danger', 'success', 'urgent', 'ok',
  'yes', 'no', 'partial', 'green', 'yellow', 'red', 'blue', 'orange',
  'high', 'medium', 'low',
  // Pagefind internal classes injected by pagefind-ui.js
  'pagefind-ui', 'pagefind-modular-input',
]);

export function extractHtmlClasses(html) {
  const classes = new Set();
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const value = m[1];
    for (const c of value.split(/\s+/)) {
      if (!c) continue;
      // Drop runtime-composed tokens like cell-${s} or {{name}}
      // but keep static siblings (e.g. class="tag ${dynamic}" -> {"tag"})
      if (c.includes('${') || c.includes('{{')) continue;
      classes.add(c);
    }
  }
  return classes;
}

export function extractCssClasses(css) {
  // strip /* ... */ comments (DOTALL)
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const classes = new Set();
  const re = /\.([a-zA-Z_][\w-]*)/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    classes.add(m[1]);
  }
  return classes;
}

export function inlineStyles(html) {
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  const parts = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    parts.push(m[1]);
  }
  return parts.join('\n');
}

function union(...sets) {
  const out = new Set();
  for (const s of sets) for (const v of s) out.add(v);
  return out;
}

function difference(a, b) {
  const out = new Set();
  for (const v of a) if (!b.has(v)) out.add(v);
  return out;
}

export function findUndefinedByPage(docs, sharedClasses) {
  const pages = readdirSync(docs).filter((f) => f.endsWith('.html')).sort();
  const out = [];
  for (const name of pages) {
    const file = path.join(docs, name);
    const html = readFileSync(file, 'utf8');
    const used = extractHtmlClasses(html);
    const defined = union(sharedClasses, extractCssClasses(inlineStyles(html)), SAFE);
    const missing = difference(used, defined);
    if (missing.size) out.push([name, missing]);
  }
  return out;
}

function parseArgs(argv) {
  const out = { repo: null, extraCss: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--extra-css') out.extraCss.push(argv[++i]);
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'usage: check-undefined-classes.mjs [--repo PATH] [--extra-css PATH]...\n'
      );
      process.exit(0);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo ? path.resolve(args.repo) : path.resolve(SCRIPT_DIR, '..');
  const docs = path.join(repo, 'docs');
  if (!existsSync(docs)) {
    process.stderr.write(`docs/ directory not found at ${docs}\n`);
    return 0;
  }

  const sharedCssFile = path.join(docs, 'styles.css');
  let sharedClasses = new Set();
  if (existsSync(sharedCssFile)) {
    sharedClasses = union(sharedClasses, extractCssClasses(readFileSync(sharedCssFile, 'utf8')));
  }
  for (const extra of args.extraCss) {
    if (existsSync(extra)) {
      sharedClasses = union(sharedClasses, extractCssClasses(readFileSync(extra, 'utf8')));
    }
  }

  const undefinedByPage = findUndefinedByPage(docs, sharedClasses);
  for (const [page, missing] of undefinedByPage) {
    const joined = [...missing].sort().join(', ');
    process.stdout.write(`undefined-classes: docs/${page}: ${joined}\n`);
  }
  return 0;
}

// Run main() when invoked as a script (not when imported). Matches the
// pattern used by every other generator - path.resolve normalises symlinks
// and relative paths so imports don't accidentally trigger a CLI run.
const invokedDirect =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirect) {
  process.exit(main());
}
