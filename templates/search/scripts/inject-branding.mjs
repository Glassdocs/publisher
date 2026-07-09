#!/usr/bin/env node
// Sitewide branding injection. Reads docs/features.json -> branding,
// then on every docs/*.html:
//   1. Injects <style id="branding-vars">:root { --accent: ...; ... }</style>
//      into <head> (CSS custom properties; cascades override the
//      playbook's default styles.css values).
//   2. Rewrites <img class="topbar-logo"> src and alt to match.
//
// Idempotent: wraps the <head> injection in <!-- @branding --> ...
// <!-- /@branding --> markers and replaces on rerun. Logo rewrites
// are inherently idempotent (they target an existing <img> tag).
//
// Per-page opt-out: <!-- @no-branding --> anywhere in the file.
//
// Supported branding keys (any subset; missing keys leave the playbook
// defaults in place):
//   logo       - string. <img class="topbar-logo"> src. Local path
//                inside docs/ OR a full https:// URL.
//   logoAlt    - string. The alt attribute on the topbar logo image.
//   accent     - CSS color. Sets --accent (links, hovers, badges).
//   lineColor  - CSS color. Sets --border (topbar/sidebar/cards).
//   text       - CSS color. Sets --text (default body text).
//   bg         - CSS color. Sets --bg (page background).
//   textMuted  - CSS color. Sets --text-muted (secondary text).
//
// Usage:
//   node inject-branding.mjs              # auto-detect repo root
//   node inject-branding.mjs --repo PATH  # explicit repo root

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeAttr, replaceOrInsertBlock, stripBlockBetween } from './lib/inject-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const START = '<!-- @branding -->';
export const END = '<!-- /@branding -->';
export const OPT_OUT = '<!-- @no-branding -->';

// Map branding-key -> CSS var name. Kept small + explicit so a typo'd
// key fails loudly (treated as "no value") rather than silently
// emitting a weird CSS var.
export const VAR_MAP = {
  accent: '--accent',
  lineColor: '--border',
  text: '--text',
  bg: '--bg',
  textMuted: '--text-muted',
};

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: inject-branding.mjs [--repo PATH]\n');
      process.exit(0);
    }
  }
  return out;
}

// ── Parse + validate branding ────────────────────────────────────────

/**
 * Load `branding` from docs/features.json. Returns {} if features.json
 * is missing, malformed, or has no branding block. Errors are silent
 * by design: inject-branding is gated on the workflow's features step,
 * which already validates JSON shape.
 */
export function loadBranding(docs) {
  const featuresPath = path.join(docs, 'features.json');
  if (!existsSync(featuresPath)) return {};
  let parsed;
  try { parsed = JSON.parse(readFileSync(featuresPath, 'utf8')); }
  catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.branding !== 'object'
      || parsed.branding === null) return {};
  return parsed.branding;
}

/**
 * True when a branding object is non-empty AND has at least one
 * recognised key. `{ unknownKey: 'foo' }` is considered empty - we
 * don't want to inject an empty <style> block for a typo.
 */
export function hasAnyBranding(branding) {
  if (!branding || typeof branding !== 'object') return false;
  if (typeof branding.logo === 'string' && branding.logo.length > 0) return true;
  if (typeof branding.logoAlt === 'string' && branding.logoAlt.length > 0) return true;
  for (const key of Object.keys(VAR_MAP)) {
    if (typeof branding[key] === 'string' && branding[key].length > 0) return true;
  }
  return false;
}

// ── Render <style> block ─────────────────────────────────────────────

// Strip any character that would let a value break out of its CSS
// declaration. Real CSS color values use only [#0-9a-zA-Z(),.%/\s-]
// plus a leading # for hex - none of {};<>"' belongs there. A
// typo'd value like "red; color: yellow" is silently neutered to
// "red color yellow" rather than injecting an extra declaration into
// :root, which would otherwise cascade sitewide.
const escapeCss = (s) => String(s).replace(/[<>"'{};]/g, '');

export function renderStyleBlock(branding) {
  const decls = [];
  for (const [key, cssVar] of Object.entries(VAR_MAP)) {
    const v = branding[key];
    if (typeof v === 'string' && v.length > 0) {
      decls.push(`  ${cssVar}: ${escapeCss(v)};`);
    }
  }
  if (!decls.length) return '';
  return `${START}
<style id="branding-vars">
:root {
${decls.join('\n')}
}
</style>
${END}`;
}

// ── Logo rewrite ─────────────────────────────────────────────────────

/**
 * True for URLs that are safe to drop into <img src>:
 *   - any relative path or root-absolute path (no scheme)
 *   - https:// URLs
 * Everything else (javascript:, data:, file:, http:, vbscript:, etc.)
 * is rejected. Browsers won't execute javascript: in <img src>, but
 * data: would let an arbitrary payload skirt the site's CSP img-src
 * policy and http: would warn on https sites about mixed content.
 * Reject control characters and whitespace defensively too.
 */
export function isSafeLogoUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\s]/.test(url)) return false;
  // Check for a URL scheme (matches `name:` at the start).
  const schemeMatch = url.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) return true; // no scheme = relative or root-absolute path
  return schemeMatch[1].toLowerCase() === 'https';
}

/**
 * Rewrite the `src` (and optionally `alt`) of any <img class="topbar-logo">
 * on the page to match branding.logo / branding.logoAlt. Only mutates
 * attributes that are explicitly set in branding - missing keys leave
 * the existing values alone.
 *
 * Matches <img ... class="...topbar-logo..." ...> in either attribute
 * order. Hand-written topbar markup may put class before src, src
 * before class, with multiple classes, etc. - the rewrite walks each
 * <img> and only mutates ones that contain `topbar-logo` as a
 * whitespace-bounded class token.
 */
export function rewriteLogo(html, branding) {
  if (typeof branding.logo !== 'string' && typeof branding.logoAlt !== 'string') {
    return { changed: false, html };
  }
  let changed = false;
  const newHtml = html.replace(/<img\b[^>]*>/gi, (tag) => {
    // Whitespace-bounded class token check (avoids matching e.g.
    // "my-topbar-logo-thing" as a topbar-logo).
    const classMatch = tag.match(/\bclass\s*=\s*"([^"]*)"/i)
      || tag.match(/\bclass\s*=\s*'([^']*)'/i);
    if (!classMatch) return tag;
    const classes = classMatch[1].split(/\s+/);
    if (!classes.includes('topbar-logo')) return tag;

    let updated = tag;
    if (typeof branding.logo === 'string' && branding.logo.length > 0) {
      // Reject unsafe URL schemes (javascript:, data:, http:, etc.).
      // Silently drop the rewrite rather than corrupting the page; the
      // log line tells the operator something was rejected.
      if (!isSafeLogoUrl(branding.logo)) {
        process.stderr.write(`branding.logo rejected (unsafe URL): ${branding.logo}\n`);
      } else {
        const newSrc = escapeAttr(branding.logo);
        const srcRe = /\b(src)\s*=\s*("[^"]*"|'[^']*')/i;
        if (srcRe.test(updated)) {
          updated = updated.replace(srcRe, `$1="${newSrc}"`);
        } else {
          updated = updated.replace(/<img\b/i, `<img src="${newSrc}"`);
        }
      }
    }
    if (typeof branding.logoAlt === 'string' && branding.logoAlt.length > 0) {
      const newAlt = escapeAttr(branding.logoAlt);
      const altRe = /\b(alt)\s*=\s*("[^"]*"|'[^']*')/i;
      if (altRe.test(updated)) {
        updated = updated.replace(altRe, `$1="${newAlt}"`);
      } else {
        updated = updated.replace(/<img\b/i, `<img alt="${newAlt}"`);
      }
    }
    if (updated !== tag) changed = true;
    return updated;
  });
  return { changed, html: newHtml };
}

// ── Page-level injection ─────────────────────────────────────────────

/**
 * Returns { changed, html }. Idempotent on rerun. Skips pages that:
 *   - contain the OPT_OUT marker
 *   - have no </head> (no place to put the <style> block)
 */
export function injectBranding(html, branding) {
  if (html.includes(OPT_OUT)) {
    const stripped = stripBlockBetween(html, START, END);
    return { changed: stripped !== html, html: stripped };
  }

  let working = html;
  let mutated = false;

  // Style block injection (only if any CSS-var keys are set).
  const styleBlock = renderStyleBlock(branding);
  if (styleBlock) {
    const r = replaceOrInsertBlock(working, START, END, styleBlock, /<\/head>/i, { before: true });
    if (r.changed) { working = r.html; mutated = true; }
  } else {
    // Branding has no CSS vars set; strip any prior block (e.g. user
    // removed all colors but kept the logo).
    const stripped = stripBlockBetween(working, START, END);
    if (stripped !== working) { working = stripped; mutated = true; }
  }

  // Logo + alt rewrite (independent of style block).
  const logoResult = rewriteLogo(working, branding);
  if (logoResult.changed) { working = logoResult.html; mutated = true; }

  return { changed: mutated, html: working };
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

  const branding = loadBranding(docs);
  if (!hasAnyBranding(branding)) {
    process.stdout.write('No branding configured (features.json has no recognised branding keys); skipping.\n');
    return 0;
  }

  const files = readdirSync(docs).filter((f) => f.endsWith('.html'));
  let touched = 0;
  for (const name of files) {
    const p = path.join(docs, name);
    if (!statSync(p).isFile()) continue;
    const before = readFileSync(p, 'utf8');
    const { changed, html } = injectBranding(before, branding);
    if (changed) {
      writeFileSync(p, html);
      touched++;
      process.stdout.write(`${name}: branding injected/updated\n`);
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
