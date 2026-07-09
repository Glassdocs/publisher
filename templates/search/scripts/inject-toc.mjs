#!/usr/bin/env node
// Inject a per-page table of contents into every docs/*.html that has
// 2+ <h2> or <h3> headings inside <main>. Idempotent: wraps output in
// <!-- @toc --> ... <!-- /@toc --> markers and replaces on rerun.
//
// Side effect: ensures every targeted heading has an `id` attribute.
// Slug logic is intentionally duplicated from add-heading-ids.mjs to
// keep this script standalone (search add-on may not be enabled).
//
// Per-page opt-out: add `<!-- @no-toc -->` anywhere in the file.
//
// Usage:
//   node inject-toc.mjs              # auto-detect repo root
//   node inject-toc.mjs --repo PATH  # explicit repo root

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeAttr, escapeText, replaceOrInsertBlock, stripBlockBetween } from './lib/inject-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const START = '<!-- @toc -->';
export const END = '<!-- /@toc -->';
export const OPT_OUT = '<!-- @no-toc -->';
export const MIN_HEADINGS = 2;

// ── CLI ──────────────────────────────────────────────────────────────

export const PLACEMENTS = ['inline', 'rail'];

function parseArgs(argv) {
  const out = { repo: null, placement: 'inline' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--placement') out.placement = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: inject-toc.mjs [--repo PATH] [--placement inline|rail]\n');
      process.exit(0);
    }
  }
  if (!PLACEMENTS.includes(out.placement)) {
    process.stderr.write(`invalid --placement '${out.placement}', expected one of ${PLACEMENTS.join('|')}\n`);
    process.exit(2);
  }
  return out;
}

// ── Slug + id ensure ─────────────────────────────────────────────────

export function slugify(raw) {
  return raw
    .replace(/<[^>]+>/g, ' ')
    // Strip both named (&amp;) and numeric (&#39;, &#x27;) HTML entities.
    // The previous /&[a-z]+;/gi only matched named ones, so a heading
    // like "Don&#39;t" leaked the digits into the slug as "don39t".
    .replace(/&[^;\s]+;/g, ' ')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Re-export the shared escape helpers so existing tests that import
// them from this module keep working.
export { escapeAttr, escapeText };

// ── Heading extraction (h2/h3 inside <main>) ─────────────────────────

/**
 * Pure scan of h2/h3 headings inside <main>. Does NOT mutate the html.
 * Returns headings in source order, each with:
 *   - level: 2 | 3
 *   - text:  visible text content (tags stripped, whitespace squeezed)
 *   - id:    existing id when set on the tag, otherwise a slug proposal.
 *           ids are NOT yet committed to the file; injectToc decides
 *           whether to write them based on whether a TOC actually goes
 *           in. This avoids dirtying files that would have no TOC anyway.
 *   - hasId: true if the heading already has an id attribute on the tag,
 *           false if `id` is a proposed slug. Used by ensureIds to know
 *           which headings need rewriting.
 *
 * Pages without a <main> return an empty array - the auto-toc concept
 * assumes a single main content region.
 */
export function extractHeadings(html) {
  const headings = [];
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/);
  if (!mainMatch) return { headings, html };

  const main = mainMatch[1];
  const seen = new Set();
  // Pre-collect existing ids in <main> so any proposed slug doesn't
  // collide with them.
  const idRe = /\sid\s*=\s*["']([^"']+)["']/g;
  let m;
  while ((m = idRe.exec(main)) !== null) seen.add(m[1]);

  const headRe = /<(h[23])([^>]*)>([\s\S]*?)<\/\1>/g;
  while ((m = headRe.exec(main)) !== null) {
    const tag = m[1];
    const attrs = m[2];
    const inner = m[3];
    const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const idMatch = attrs.match(/\sid\s*=\s*["']([^"']+)["']/);
    let id;
    let hasId;
    if (idMatch) {
      id = idMatch[1];
      hasId = true;
    } else {
      const base = slugify(inner);
      if (!base) continue;
      id = base;
      let n = 2;
      while (seen.has(id)) id = `${base}-${n++}`;
      seen.add(id);
      hasId = false;
    }

    headings.push({ level: tag === 'h2' ? 2 : 3, id, text, hasId });
  }

  return { headings, html };
}

/**
 * Commit the proposed ids from extractHeadings into the html. Only
 * called by injectToc once we've decided a TOC is actually going in
 * (so we don't dirty files that wouldn't get a TOC anyway).
 */
export function ensureIds(html, headings) {
  const need = headings.filter((h) => !h.hasId);
  if (!need.length) return html;
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/);
  if (!mainMatch) return html;

  const main = mainMatch[1];
  // Walk heading occurrences in source order and pair them with the
  // entries from `headings` by position - extractHeadings produced them
  // in the same order so we can zip without a second slug round-trip.
  const headRe = /<(h[23])([^>]*)>([\s\S]*?)<\/\1>/g;
  let i = 0;
  let edits = [];
  let m;
  while ((m = headRe.exec(main)) !== null) {
    const heading = headings[i++];
    if (!heading || heading.hasId) continue;
    const fullMatch = m[0];
    const start = m.index;
    const tag = m[1];
    const attrs = m[2];
    const inner = m[3];
    const replacement = `<${tag}${attrs} id="${heading.id}">${inner}</${tag}>`;
    edits.push({ start, end: start + fullMatch.length, replacement });
  }

  if (!edits.length) return html;

  edits.sort((a, b) => b.start - a.start);
  let newMain = main;
  for (const e of edits) {
    newMain = newMain.slice(0, e.start) + e.replacement + newMain.slice(e.end);
  }
  return (
    html.slice(0, mainMatch.index) +
    mainMatch[0].replace(main, newMain) +
    html.slice(mainMatch.index + mainMatch[0].length)
  );
}

// ── TOC HTML rendering ───────────────────────────────────────────────

/**
 * Render the TOC block. `placement` selects between:
 *   - "inline" (default): banner-style block at the top of <main>;
 *     works on any layout including narrow / single-column.
 *   - "rail": sticky right-side panel (the React/Tailwind/Stripe
 *     "On this page" pattern). Requires horizontal room - collapses
 *     to inline below 1024px viewport via @media query.
 *
 * Both modes use the same `.auto-toc` class so site overrides apply
 * to either; the rail variant adds `.auto-toc-rail` for the layout
 * styling. Plain CSS only - no JS scrollspy yet.
 */
export function renderToc(headings, placement = 'inline') {
  if (headings.length < MIN_HEADINGS) return '';
  const items = headings.map((h) => {
    const cls = h.level === 3 ? ' class="toc-sub"' : '';
    return `<li${cls}><a href="#${escapeAttr(h.id)}">${escapeText(h.text)}</a></li>`;
  });
  if (placement === 'rail') return renderRail(items);
  return renderInline(items);
}

function renderInline(items) {
  return `${START}
<aside class="auto-toc" aria-label="Table of contents" style="margin: 0 0 24px; padding: 12px 16px; border-left: 3px solid var(--accent, currentColor); background: rgba(128,128,128,0.06); border-radius: 6px;">
  <strong style="display: block; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted, rgba(128,128,128,1)); margin-bottom: 8px;">On this page</strong>
  <ul style="list-style: none; padding: 0; margin: 0; font-size: 14px; line-height: 1.7;">
    ${items.join('\n    ')}
  </ul>
</aside>
${END}`;
}

function renderRail(items) {
  // The rail variant ships its CSS in a <style> tag instead of inline
  // style attributes because @media queries can't be inline. Below
  // 1024px the rail collapses to the inline banner so the TOC is
  // still visible on tablet/mobile.
  return `${START}
<style>
.auto-toc-rail {
  margin: 0 0 24px;
  padding: 12px 16px;
  border-left: 3px solid var(--accent, currentColor);
  background: rgba(128,128,128,0.06);
  border-radius: 6px;
}
.auto-toc-rail .auto-toc-title {
  display: block; font-size: 13px; text-transform: uppercase;
  letter-spacing: 0.5px; color: var(--text-muted, rgba(128,128,128,1));
  margin-bottom: 8px;
}
.auto-toc-rail ul {
  list-style: none; padding: 0; margin: 0;
  font-size: 14px; line-height: 1.7;
}
.auto-toc-rail li.toc-sub { padding-left: 14px; }
@media (min-width: 1024px) {
  /* Rail mode: float the panel to the right of the main content.
     The left margin pulls subsequent flow content back left so prose
     wraps around the narrow rail. Sticky positioning keeps it in
     view as the user scrolls. */
  .auto-toc-rail {
    float: right;
    width: 220px;
    margin: 0 0 24px 24px;
    position: sticky;
    top: 24px;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
  }
}
</style>
<aside class="auto-toc auto-toc-rail" aria-label="Table of contents">
  <strong class="auto-toc-title">On this page</strong>
  <ul>
    ${items.join('\n    ')}
  </ul>
</aside>
${END}`;
}

// ── Page-level injection ─────────────────────────────────────────────

/**
 * Returns { changed: boolean, html: string }. Idempotent on rerun.
 * Skips pages that:
 *   - contain the OPT_OUT marker
 *   - have no <main>
 *   - have fewer than MIN_HEADINGS h2/h3 headings
 *
 * Heading ids are written ONLY when a TOC is actually being injected,
 * so pages that don't qualify stay byte-identical (no spurious commit
 * noise from id-only edits to pages that won't have a TOC anyway).
 */
export function injectToc(html, placement = 'inline') {
  if (html.includes(OPT_OUT)) {
    // Strip any previously-injected TOC if the page just opted out.
    const stripped = stripBlockBetween(html, START, END);
    return { changed: stripped !== html, html: stripped };
  }

  const { headings } = extractHeadings(html);
  const toc = renderToc(headings, placement);

  if (!toc) {
    // Page doesn't qualify (no <main>, no headings, or under threshold).
    // Remove any prior injection so we don't leave a stale TOC behind,
    // but don't otherwise touch the file.
    const stripped = stripBlockBetween(html, START, END);
    return { changed: stripped !== html, html: stripped };
  }

  // Commit ids now that we know a TOC is going in. The TOC block is
  // inserted AFTER the <main> opening tag (anchor below) - replaceOrInsertBlock
  // appends after the anchor by default, which is what we want here.
  const withIds = ensureIds(html, headings);
  const result = replaceOrInsertBlock(withIds, START, END, toc, /<main[^>]*>/);
  // Re-base `changed` on the original html (ensureIds may have mutated
  // withIds while injection didn't add anything new).
  return { changed: result.html !== html, html: result.html };
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

  const files = readdirSync(docs).filter((f) => f.endsWith('.html'));
  let touched = 0;
  for (const name of files) {
    const p = path.join(docs, name);
    if (!statSync(p).isFile()) continue;
    const before = readFileSync(p, 'utf8');
    const { changed, html } = injectToc(before, args.placement);
    if (changed) {
      writeFileSync(p, html);
      touched++;
      process.stdout.write(`${name}: toc injected/updated (${args.placement})\n`);
    }
  }
  process.stdout.write(`done - touched ${touched} of ${files.length} file(s) [placement=${args.placement}]\n`);
  return 0;
}

const INVOKED_AS_CLI =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_AS_CLI) {
  process.exit(main());
}
