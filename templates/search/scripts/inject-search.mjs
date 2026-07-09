#!/usr/bin/env node
// Inject Pagefind search markup into HTML pages that have the standard topbar.
//
// Adds three things (idempotent - skips pages that already have them):
//   1. <link href="/pagefind/pagefind-ui.css" rel="stylesheet"> in <head>
//   2. <div class="site-search" id="search"></div> inside the topbar
//   3. PagefindUI init script + <script src="/pagefind/pagefind-ui.js"> before </body>
//
// Usage:
//   node inject-search.mjs              # auto-detect repo root
//   node inject-search.mjs --repo PATH  # explicit repo root

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Alias the Node global so we can also export a `process` function below
// without shadowing it inside this module.
const proc = globalThis.process;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const PAGEFIND_CSS = '<link href="/pagefind/pagefind-ui.css" rel="stylesheet">';
export const SEARCH_DIV = '<div class="site-search" id="search"></div>';
export const PAGEFIND_JS = '<script src="/pagefind/pagefind-ui.js"></script>';
export const PAGEFIND_INIT =
  '<script>window.addEventListener("DOMContentLoaded",function(){' +
  'var s=document.getElementById("search");if(!s)return;' +
  'var mac=/Mac|iPhone|iPad|iPod/i.test(navigator.platform);' +
  'var hint=mac?"\\u2318K":"Ctrl+K";' +
  'if(typeof PagefindUI!=="undefined"){' +
  'new PagefindUI({element:"#search",showSubResults:true,showImages:false,' +
  'resetStyles:false,translations:{placeholder:"Search "+hint}});' +
  '}' +
  'document.addEventListener("keydown",function(e){' +
  'var i=document.querySelector("#search input");' +
  'if((e.metaKey||e.ctrlKey)&&(e.key==="k"||e.key==="K")){' +
  'e.preventDefault();if(i){i.focus();i.select();}' +
  '}else if(e.key==="Escape"&&i&&document.activeElement===i){i.blur();}' +
  '});' +
  '});</script>';

function parseArgs(argv) {
  const out = { repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '-h' || a === '--help') {
      proc.stdout.write('usage: inject-search.mjs [--repo PATH]\n');
      proc.exit(0);
    }
  }
  return out;
}

// Replace only the first occurrence of `needle` with `replacement`.
function replaceFirst(haystack, needle, replacement) {
  const idx = haystack.indexOf(needle);
  if (idx < 0) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}

// Match a <link> tag whose href ends in "styles.css" - tolerates both
// the root-relative form `href="styles.css"` (most pages) and the
// root-absolute form `href="/styles.css"` (404.html and any standalone
// page that needs to load assets from any served URL). Matching only
// the literal relative form silently skipped 404.html in the past, so
// the search bar shipped without styling there.
const STYLES_LINK_RE = /<link\b[^>]*\bhref\s*=\s*["'][^"']*\bstyles\.css["'][^>]*>/i;

export function injectCss(html) {
  if (html.includes('pagefind-ui.css')) return html;
  const m = html.match(STYLES_LINK_RE);
  if (!m) return html;
  // Use a function-replacement so $-substitution in the matched tag
  // can't accidentally trigger String.prototype.replace's special syntax.
  return html.replace(STYLES_LINK_RE, () => `${PAGEFIND_CSS}\n${m[0]}`);
}

export function injectSearchDiv(html) {
  if (html.includes('id="search"') || html.includes('class="site-search"')) return html;
  // Add a search div at the end of the topbar links nav, or at the end of topbar.
  const m = html.match(/<\/nav>\s*<\/header>/);
  if (m) {
    return replaceFirst(html, m[0], `</nav>\n  ${SEARCH_DIV}\n</header>`);
  }
  // Fallback: insert before </header>, reusing the captured leading whitespace
  // on both sides (matches the Python `re.sub` with the \1 backref twice).
  return html.replace(
    /(\s*)<\/header>/,
    (_match, ws) => `${ws}  ${SEARCH_DIV}${ws}</header>`,
  );
}

export function injectScripts(html) {
  if (html.includes('pagefind-ui.js')) return html;
  const injection = `${PAGEFIND_INIT}\n${PAGEFIND_JS}\n`;
  return replaceFirst(html, '</body>', `${injection}</body>`);
}

export function process(filePath) {
  const before = readFileSync(filePath, 'utf8');
  if (!before.includes('<header class="topbar"')) return false;
  let after = injectCss(before);
  after = injectSearchDiv(after);
  after = injectScripts(after);
  if (after !== before) {
    writeFileSync(filePath, after);
    return true;
  }
  return false;
}

function main() {
  const args = parseArgs(proc.argv.slice(2));
  const repo = args.repo ? path.resolve(args.repo) : path.resolve(SCRIPT_DIR, '..');
  const docs = path.join(repo, 'docs');
  if (!existsSync(docs)) {
    proc.stderr.write(`docs/ directory not found at ${docs}\n`);
    return 1;
  }
  const pages = readdirSync(docs).filter((f) => f.endsWith('.html')).sort();
  let changed = 0;
  for (const name of pages) {
    if (process(path.join(docs, name))) changed++;
  }
  proc.stdout.write(`inject-search: updated ${changed}/${pages.length} pages\n`);
  return 0;
}

// Only run main() when invoked directly, not when imported.
const INVOKED_DIRECTLY =
  proc.argv[1] && fileURLToPath(import.meta.url) === path.resolve(proc.argv[1]);

if (INVOKED_DIRECTLY) {
  proc.exit(main());
}
