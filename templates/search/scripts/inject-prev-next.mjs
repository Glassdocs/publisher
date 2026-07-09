#!/usr/bin/env node
// Inject prev/next page navigation into every docs/*.html that appears
// in docs/nav.json (in nav order). Idempotent: wraps the injected
// block in <!-- @prev-next --> ... <!-- /@prev-next --> markers and
// replaces on rerun.
//
// Per-page opt-out: <!-- @no-prev-next --> anywhere in the file.
//
// Pages NOT in nav.json (e.g. index/404/sitemap/changelog/references)
// are skipped - they're not part of the sequential reading flow.
//
// Usage:
//   node inject-prev-next.mjs              # auto-detect repo root
//   node inject-prev-next.mjs --repo PATH  # explicit repo root

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNavConfig } from './lib/nav.mjs';
import { escapeAttr, escapeText, replaceOrInsertBlock, stripBlockBetween } from './lib/inject-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const START = '<!-- @prev-next -->';
export const END = '<!-- /@prev-next -->';
export const OPT_OUT = '<!-- @no-prev-next -->';

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: inject-prev-next.mjs [--repo PATH]\n');
      process.exit(0);
    }
  }
  return out;
}

// ── Nav flattening ───────────────────────────────────────────────────

/**
 * Walk a NavConfig.items tree and produce a flat ordered list of
 * { href, label } entries. Top-level leaves come first (in source
 * order), then dropdown children in source order. The ORDER is what
 * defines the prev/next sequence - if authors want a different
 * reading order, they edit nav.json.
 *
 * Top-level dropdown PARENTS (label-only, no href) are not entries
 * themselves - just their children show up in the sequence.
 */
export function flatNavEntries(items) {
  const out = [];
  for (const item of items) {
    if (typeof item.href === 'string') {
      out.push({ href: item.href, label: item.label });
    }
    if (Array.isArray(item.children)) {
      for (const c of item.children) {
        if (typeof c.href === 'string') {
          out.push({ href: c.href, label: c.label });
        }
      }
    }
  }
  return out;
}

/**
 * Returns { self, prev, next } for the given filename, or null when
 * the file isn't in the flat list.
 */
export function neighborsFor(flat, filename) {
  const idx = flat.findIndex((e) => e.href === filename);
  if (idx === -1) return null;
  return {
    self: flat[idx],
    prev: idx > 0 ? flat[idx - 1] : null,
    next: idx < flat.length - 1 ? flat[idx + 1] : null,
  };
}

// ── Render ───────────────────────────────────────────────────────────

export function renderPrevNext(prev, next) {
  if (!prev && !next) return '';
  const left = prev
    ? `<a class="pn-prev" href="${escapeAttr(prev.href)}" rel="prev">` +
      `<span class="pn-arrow">&larr;</span>` +
      `<span class="pn-label"><span class="pn-hint">Previous</span>` +
      `<span class="pn-title">${escapeText(prev.label)}</span></span></a>`
    : '<span class="pn-spacer"></span>';
  const right = next
    ? `<a class="pn-next" href="${escapeAttr(next.href)}" rel="next">` +
      `<span class="pn-label"><span class="pn-hint">Next</span>` +
      `<span class="pn-title">${escapeText(next.label)}</span></span>` +
      `<span class="pn-arrow">&rarr;</span></a>`
    : '<span class="pn-spacer"></span>';
  // Inline minimal styling so the add-on works without sites adding
  // CSS. Sites can override `.prev-next` and its children for custom
  // theming (later rules win).
  return `${START}
<style>
/* Defaults use neutral-gray rgba so the block looks reasonable on
   either light or dark backgrounds when the host site doesn't define
   theme variables. Sites that DO define --border, --text, --accent,
   etc. get those values via the var() fallback chain. */
.prev-next {
  display: flex; gap: 16px; justify-content: space-between;
  margin: 32px 0 8px; padding-top: 16px;
  border-top: 1px solid var(--border, rgba(128,128,128,0.25));
  font-size: 14px;
}
.prev-next a {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-radius: 6px;
  border: 1px solid var(--border, rgba(128,128,128,0.25));
  color: var(--text, inherit); text-decoration: none;
  flex: 1; max-width: 48%;
  transition: border-color 0.15s, background 0.15s;
}
.prev-next a:hover {
  border-color: var(--accent, currentColor);
  background: var(--accent-bg, rgba(128,128,128,0.08));
}
.prev-next .pn-next { justify-content: flex-end; text-align: right; }
.prev-next .pn-arrow { font-size: 18px; color: var(--text-muted, rgba(128,128,128,1)); flex: 0 0 auto; }
.prev-next .pn-label { display: flex; flex-direction: column; min-width: 0; }
.prev-next .pn-hint { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted, rgba(128,128,128,1)); }
.prev-next .pn-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prev-next .pn-spacer { flex: 1; max-width: 48%; }
</style>
<nav class="prev-next" aria-label="Page navigation">${left}${right}</nav>
${END}`;
}

// ── Page-level injection ─────────────────────────────────────────────

/**
 * Returns { changed, html }. Idempotent on rerun. Skips pages that:
 *   - contain the OPT_OUT marker
 *   - have no <main>
 *   - are not in `flat` (filename match)
 *
 * Inserts the prev/next block just before </main> so it appears at the
 * end of the main content region.
 */
export function injectPrevNext(html, flat, filename) {
  if (html.includes(OPT_OUT)) {
    const stripped = stripBlockBetween(html, START, END);
    return { changed: stripped !== html, html: stripped };
  }
  const neighbors = neighborsFor(flat, filename);
  if (!neighbors) {
    // Page not in nav - strip any prior block (in case the file was
    // removed from nav.json after a previous deploy injected one).
    const stripped = stripBlockBetween(html, START, END);
    return { changed: stripped !== html, html: stripped };
  }
  const block = renderPrevNext(neighbors.prev, neighbors.next);
  if (!block) {
    // Single-entry nav: no prev, no next. Strip any prior block.
    const stripped = stripBlockBetween(html, START, END);
    return { changed: stripped !== html, html: stripped };
  }
  // Insert just before </main>; pages without </main> get changed:false.
  return replaceOrInsertBlock(html, START, END, block, /<\/main>/i, { before: true });
}

// ── Main ─────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo
    ? path.resolve(args.repo)
    : path.resolve(SCRIPT_DIR, '..');
  const docs = path.join(repo, 'docs');

  if (!existsSync(docs)) {
    process.stderr.write(`docs/ directory not found at ${docs}\n`);
    return 1;
  }

  const navPath = path.join(docs, 'nav.json');
  if (!existsSync(navPath)) {
    process.stdout.write('docs/nav.json not found - skipping (prev/next requires nav.json)\n');
    return 0;
  }
  const navConfig = parseNavConfig(readFileSync(navPath, 'utf8'));
  if (!navConfig) {
    process.stderr.write('docs/nav.json failed to parse - prev/next skipped\n');
    return 1;
  }
  const flat = flatNavEntries(navConfig.items);

  const files = readdirSync(docs).filter((f) => f.endsWith('.html'));
  let touched = 0;
  for (const name of files) {
    const p = path.join(docs, name);
    if (!statSync(p).isFile()) continue;
    const before = readFileSync(p, 'utf8');
    const { changed, html } = injectPrevNext(before, flat, name);
    if (changed) {
      writeFileSync(p, html);
      touched++;
      process.stdout.write(`${name}: prev/next injected/updated\n`);
    }
  }
  process.stdout.write(`done - touched ${touched} of ${files.length} file(s)\n`);
  return 0;
}

const INVOKED_AS_CLI =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_AS_CLI) {
  process.exit(main());
}
