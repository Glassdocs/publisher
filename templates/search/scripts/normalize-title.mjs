#!/usr/bin/env node
// Normalise every HTML page's <title> to match the site's main title.
//
// Reads the project name from docs/index.html's <span class="badge"> and
// sets <title>{name}</title> on every HTML page that has a standard topbar.
// Makes browser tabs/history entries consistent across the site.
//
// Skips *-pdf.html pages and pages with no topbar (standalone documents
// keep their specific titles).
//
// Usage:
//   node normalize-title.mjs              # auto-detect repo root
//   node normalize-title.mjs --repo PATH  # explicit repo root

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const out = { repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: normalize-title.mjs [--repo PATH]\n');
      process.exit(0);
    }
  }
  return out;
}

// Extract the site title from docs/index.html's <span class="badge">.
// Returns the trimmed badge text, or null if the file or badge is missing.
export function getSiteTitle(docs) {
  const index = path.join(docs, 'index.html');
  if (!existsSync(index)) return null;
  const html = readFileSync(index, 'utf8');
  const m = html.match(/<span class="badge">([\s\S]*?)<\/span>/);
  if (!m) return null;
  return m[1].trim();
}

// Escape HTML special chars so the badge text can be safely dropped
// into the <title> element. A raw `<` or `&` would break the document;
// `</title>` inside the badge would let the title escape its own tag.
function escapeForTitle(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Replace the first <title>...</title> with the new title. Leaves the
// HTML untouched when there is no <title> tag at all. Accepts an
// attribute-bearing tag (<title lang="en">...) by allowing optional
// attributes in the open-tag pattern. Uses a function-replacement so
// $& / $1 in the title can't trigger String.replace's substitution
// syntax.
export function setTitle(html, title) {
  const pattern = /<title(\s[^>]*)?>[\s\S]*?<\/title>/;
  if (!pattern.test(html)) return html;
  const safe = escapeForTitle(title);
  return html.replace(pattern, () => `<title>${safe}</title>`);
}

// True when a page should have its title normalised. Mirrors the Python
// version's rules: skip *-pdf.html, skip @page print pages, skip pages
// without a standard topbar.
export function shouldProcess(filename, html) {
  if (filename.endsWith('-pdf.html')) return false;
  if (html.includes('@page')) return false;
  if (!html.includes('<header class="topbar"')) return false;
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo ? path.resolve(args.repo) : path.resolve(SCRIPT_DIR, '..');
  const docs = path.join(repo, 'docs');
  if (!existsSync(docs)) {
    process.stderr.write(`docs/ directory not found at ${docs}\n`);
    return 1;
  }

  const title = getSiteTitle(docs);
  if (!title) {
    process.stderr.write('Could not extract site title from docs/index.html badge\n');
    return 1;
  }

  let changed = 0;
  let total = 0;
  const pages = readdirSync(docs).filter((f) => f.endsWith('.html')).sort();
  for (const name of pages) {
    total += 1;
    const file = path.join(docs, name);
    const html = readFileSync(file, 'utf8');
    if (!shouldProcess(name, html)) continue;
    const newHtml = setTitle(html, title);
    if (newHtml !== html) {
      writeFileSync(file, newHtml);
      changed += 1;
    }
  }
  process.stdout.write(`normalize-title: set title to '${title}' on ${changed}/${total} pages\n`);
  return 0;
}

// Run as CLI only when invoked directly (not when imported by tests).
const invokedDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirect) {
  process.exit(main());
}
