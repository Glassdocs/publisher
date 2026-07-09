#!/usr/bin/env node
// Inject copy-to-clipboard buttons + Prism syntax highlighting onto
// every <pre><code> block in docs/*.html. Idempotent: wraps the
// injected <head> assets in <!-- @codeblocks --> ... <!-- /@codeblocks -->
// markers and replaces on rerun.
//
// Two side effects beyond the inline payload:
//   1. Copies templates/codeblocks/{prism-bundle.min.js, prism.min.css}
//      into docs/codeblocks/ so the injected <link>+<script> tags
//      resolve at runtime. Self-hosted = no CSP changes, no CDN dep.
//   2. Adds copy buttons via inline JS (works without Prism too).
//
// Per-page opt-out: add `<!-- @no-codeblocks -->` anywhere in the file.
//
// Bundled languages (in prism-bundle.min.js): markup/html, css, clike,
// javascript (Prism core defaults) + bash, json, yaml, python,
// typescript, go, rust. Add a language by re-vendoring (see
// templates/codeblocks/README - or curl from cdnjs).
//
// Usage:
//   node inject-codeblocks.mjs              # auto-detect repo root
//   node inject-codeblocks.mjs --repo PATH  # explicit repo root

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceOrInsertBlock, stripBlockBetween } from './lib/inject-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// templates/search/scripts/ -> templates/codeblocks/
const ASSETS_SRC = path.resolve(SCRIPT_DIR, '..', '..', 'codeblocks');

export const START = '<!-- @codeblocks -->';
export const END = '<!-- /@codeblocks -->';
export const OPT_OUT = '<!-- @no-codeblocks -->';

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: inject-codeblocks.mjs [--repo PATH]\n');
      process.exit(0);
    }
  }
  return out;
}

// ── Payload (the bit that goes into <head>) ──────────────────────────

/**
 * The CSS + JS that runs in the browser. Kept inline (plus two
 * self-hosted Prism assets at /codeblocks/) so the add-on works
 * offline, doesn't touch CSP, and adds zero external requests.
 * Querying [data-cb] avoids re-decorating blocks if the script runs
 * twice (e.g. soft-nav frameworks).
 *
 * Prism CSS uses `pre[class*="language-"]` selectors so it only styles
 * code blocks that explicitly opt in via `class="language-foo"` - plain
 * <pre> blocks render with default styling. The copy button works on
 * both styles.
 */
export const PAYLOAD = `${START}
<link rel="stylesheet" href="/codeblocks/prism.min.css">
<script src="/codeblocks/prism-bundle.min.js" defer></script>
<style id="cb-fouc">
/* Hide language-tagged code until Prism applies token classes. The
   defer-loaded Prism bundle finishes before DOMContentLoaded, then the
   init handler removes this style element. Prevents the brief flash of
   unstyled code that's otherwise visible on the first frame. Untagged
   blocks aren't selected and render immediately. */
pre[class*="language-"] { visibility: hidden; }
</style>
<style>
/* Copy-button defaults use neutral rgba so they look reasonable on
   light or dark Prism themes alike. Sites that define theme vars
   (--border, --bg, --text, --accent) get those via the var() fallback
   chain and override the neutral defaults. */
.cb-wrap { position: relative; }
.cb-copy {
  position: absolute; top: 8px; right: 8px;
  padding: 4px 10px; font-size: 12px;
  border: 1px solid var(--border, rgba(128,128,128,0.4)); border-radius: 4px;
  background: var(--bg, rgba(128,128,128,0.15)); color: var(--text, currentColor);
  cursor: pointer; opacity: 0; transition: opacity 0.15s;
  font-family: inherit;
}
.cb-wrap:hover .cb-copy, .cb-copy:focus { opacity: 1; }
.cb-copy.cb-ok { border-color: var(--accent, currentColor); color: var(--accent, currentColor); }
</style>
<script>
(function () {
  function decorate(pre) {
    if (pre.dataset.cb) return;
    pre.dataset.cb = "1";
    var wrap = document.createElement("div");
    wrap.className = "cb-wrap";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cb-copy";
    btn.textContent = "Copy";
    btn.setAttribute("aria-label", "Copy code to clipboard");
    btn.addEventListener("click", function () {
      var text = pre.innerText;
      var done = function () {
        var orig = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("cb-ok");
        setTimeout(function () {
          btn.textContent = orig;
          btn.classList.remove("cb-ok");
        }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          // Fallback below.
          fallback();
        });
      } else {
        fallback();
      }
      function fallback() {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); }
        catch (e) { btn.textContent = "Copy failed"; }
        document.body.removeChild(ta);
      }
    });
    wrap.appendChild(btn);
  }
  function init() {
    var pres = document.querySelectorAll("main pre");
    for (var i = 0; i < pres.length; i++) decorate(pres[i]);
    // Prism's defer-loaded bundle has run by DOMContentLoaded; tokens
    // are in place. Drop the FOUC guard so the highlighted code becomes
    // visible. Done last so a buggy Prism load doesn't permanently hide
    // language-tagged code (we'd rather show plain text than nothing).
    var fouc = document.getElementById("cb-fouc");
    if (fouc) fouc.remove();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
</script>
${END}`;

// ── Detection + injection ────────────────────────────────────────────

/**
 * True when the page has at least one <pre> inside <main>. We only
 * decorate code in the main content region, not in topbar/footer
 * (e.g. the Pagefind init <script> block in sidepanel templates).
 *
 * Tag matching is case-insensitive because HTML element names are
 * (so authoring tools that emit <PRE> or <Main> still get detected).
 */
export function hasCodeBlocks(html) {
  const m = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (!m) return false;
  return /<pre[\s>/]/i.test(m[1]);
}

/**
 * Returns { changed, html }. Idempotent on rerun. Skips pages that:
 *   - contain the OPT_OUT marker
 *   - have no <main>
 *   - have no <pre> in <main>
 */
export function injectCodeblocks(html) {
  if (html.includes(OPT_OUT)) {
    const stripped = stripBlockBetween(html, START, END);
    return { changed: stripped !== html, html: stripped };
  }
  if (!hasCodeBlocks(html)) {
    // No code blocks - strip any prior injection so a page that
    // dropped its last <pre> doesn't keep loading the script for
    // nothing.
    const stripped = stripBlockBetween(html, START, END);
    return { changed: stripped !== html, html: stripped };
  }
  // Insert just before </head>. Pages without a </head> get changed:false.
  return replaceOrInsertBlock(html, START, END, PAYLOAD, /<\/head>/i, { before: true });
}

// ── Asset install ────────────────────────────────────────────────────

export const ASSET_FILES = ['prism-bundle.min.js', 'prism.min.css'];

/**
 * Copy the vendored Prism assets from templates/codeblocks/ into
 * docs/codeblocks/. Idempotent (overwrite-safe). Only runs when there's
 * at least one page with a code block; sites without code skip the
 * copy entirely so they don't get a stray /codeblocks/ directory.
 *
 * Returns true if assets were installed, false if skipped (no pages
 * needed them). Throws when a vendored source file is missing - that's
 * an installation issue worth surfacing loudly.
 */
export function installAssets(docs, srcDir = ASSETS_SRC) {
  const dest = path.join(docs, 'codeblocks');
  mkdirSync(dest, { recursive: true });
  for (const name of ASSET_FILES) {
    const src = path.join(srcDir, name);
    if (!existsSync(src)) {
      throw new Error(
        `Vendored Prism asset missing at ${src}. ` +
        `Re-vendor by curl-ing from cdnjs into templates/codeblocks/.`
      );
    }
    copyFileSync(src, path.join(dest, name));
  }
  return true;
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
  let anyHasBlocks = false;
  for (const name of files) {
    const p = path.join(docs, name);
    if (!statSync(p).isFile()) continue;
    const before = readFileSync(p, 'utf8');
    if (hasCodeBlocks(before)) anyHasBlocks = true;
    const { changed, html } = injectCodeblocks(before);
    if (changed) {
      writeFileSync(p, html);
      touched++;
      process.stdout.write(`${name}: codeblocks injected/updated\n`);
    }
  }
  if (anyHasBlocks) installAssets(docs);
  process.stdout.write(`done - touched ${touched} of ${files.length} file(s)\n`);
  return 0;
}

const INVOKED_AS_CLI =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_AS_CLI) {
  process.exit(main());
}
