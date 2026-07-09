#!/usr/bin/env node
// Inject callout-block CSS into every docs/*.html that uses a
// <div class="callout note|tip|warn|danger">...</div> block.
// Idempotent: wraps the injected <head> CSS in
// <!-- @callouts --> ... <!-- /@callouts --> markers.
//
// Per-page opt-out: <!-- @no-callouts --> anywhere in the file.
//
// Usage:
//   node inject-callouts.mjs              # auto-detect repo root
//   node inject-callouts.mjs --repo PATH  # explicit repo root

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceOrInsertBlock, stripBlockBetween } from './lib/inject-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const START = '<!-- @callouts -->';
export const END = '<!-- /@callouts -->';
export const OPT_OUT = '<!-- @no-callouts -->';
export const VARIANTS = ['note', 'tip', 'warn', 'danger', 'info'];

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: inject-callouts.mjs [--repo PATH]\n');
      process.exit(0);
    }
  }
  return out;
}

// ── Payload ──────────────────────────────────────────────────────────

/**
 * The CSS that styles all four callout variants. Pure CSS, no JS - so
 * callouts work with JavaScript disabled and don't add any runtime
 * cost. Each variant gets a coloured left border, tinted background,
 * and a Unicode icon via ::before so we don't need any image assets.
 *
 * Variants:
 *   .callout.note   - blue, info icon (ⓘ). Default neutral framing.
 *   .callout.info   - alias for .note.
 *   .callout.tip    - green, lightbulb-ish (★). Best practices, hints.
 *   .callout.warn   - amber, warning (⚠). Things that can bite you.
 *   .callout.danger - red, stop sign (⛔). Data loss, security issues.
 *
 * Authors can put a `<strong class="callout-title">...</strong>` as the
 * first child for an inline title row; otherwise just the body renders.
 *
 * Falls back to CSS variables (--bg, --text, --text-muted) when the
 * site theme defines them, otherwise hard-coded sensible defaults.
 */
export const PAYLOAD = `${START}
<style>
.callout {
  --co-color: #4a9eff;
  --co-bg: rgba(74, 158, 255, 0.08);
  --co-icon: "\\24D8";
  margin: 16px 0; padding: 12px 16px 12px 44px;
  border-left: 4px solid var(--co-color);
  background: var(--co-bg);
  border-radius: 6px;
  position: relative;
  color: var(--text, inherit);
  font-size: 14px; line-height: 1.6;
}
.callout::before {
  content: var(--co-icon);
  position: absolute; left: 14px; top: 12px;
  font-size: 18px; line-height: 1.2;
  color: var(--co-color);
}
.callout > .callout-title {
  display: block; margin-bottom: 4px;
  color: var(--co-color); font-weight: 600;
  letter-spacing: 0.2px;
}
.callout > p:first-child:not(.callout-title),
.callout > .callout-title + * { margin-top: 0; }
.callout > :last-child { margin-bottom: 0; }
.callout.note, .callout.info {
  --co-color: #4a9eff;
  --co-bg: rgba(74, 158, 255, 0.08);
  --co-icon: "\\24D8";
}
.callout.tip {
  --co-color: #06f4b1;
  --co-bg: rgba(6, 244, 177, 0.07);
  --co-icon: "\\2605";
}
.callout.warn {
  --co-color: #f5a623;
  --co-bg: rgba(245, 166, 35, 0.08);
  --co-icon: "\\26A0";
}
.callout.danger {
  --co-color: #ff5e57;
  --co-bg: rgba(255, 94, 87, 0.09);
  --co-icon: "\\26D4";
}
</style>
${END}`;

// ── Detection + injection ────────────────────────────────────────────

/**
 * True when the page has at least one element with a `callout` class.
 * Looks anywhere in the document (callouts can legitimately appear in
 * <main>, sidebars, footers). Matches `class="callout"` exactly or as
 * a whitespace-delimited token among other classes (any order). Will
 * NOT false-positive on substring classes like `footer-callout` or
 * `my-callout-box` (a previous \bcallout\b regex did, since `\b`
 * matches the hyphen-to-letter transition). Tested case-insensitively
 * because the `class` attribute name is case-insensitive in HTML.
 */
export function hasCallouts(html) {
  return (
    /\bclass\s*=\s*"(?:[^"]*\s)?callout(?:\s[^"]*)?"/i.test(html) ||
    /\bclass\s*=\s*'(?:[^']*\s)?callout(?:\s[^']*)?'/i.test(html)
  );
}

/**
 * Returns { changed, html }. Idempotent on rerun. Skips pages that:
 *   - contain the OPT_OUT marker
 *   - have no `.callout` class anywhere
 *   - have no </head>
 */
export function injectCallouts(html) {
  if (html.includes(OPT_OUT)) {
    const stripped = stripBlockBetween(html, START, END);
    return { changed: stripped !== html, html: stripped };
  }
  if (!hasCallouts(html)) {
    // No callouts on this page - strip any prior CSS injection so the
    // file stays minimal once the author removes their last callout.
    const stripped = stripBlockBetween(html, START, END);
    return { changed: stripped !== html, html: stripped };
  }
  return replaceOrInsertBlock(html, START, END, PAYLOAD, /<\/head>/i, { before: true });
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
    const { changed, html } = injectCallouts(before);
    if (changed) {
      writeFileSync(p, html);
      touched++;
      process.stdout.write(`${name}: callouts injected/updated\n`);
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
