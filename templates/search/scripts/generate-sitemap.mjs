#!/usr/bin/env node
// Generate docs/sitemap.html: a discoverable index of every page in the site.
//
// Project-agnostic: auto-detects project name and site chrome from
// docs/index.html via the shared lib/chrome.mjs helper. Sections are parsed
// from topbar navigation; pages not in any nav group go into an "Other"
// section.
//
// Usage:
//   node generate-sitemap.mjs              # auto-detect repo root
//   node generate-sitemap.mjs --repo PATH  # explicit repo root

import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSiteChrome, setActiveLink } from './lib/chrome.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ── CLI ──────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: generate-sitemap.mjs [--repo PATH]\n');
      process.exit(0);
    }
  }
  return out;
}

// ── HTML escaping ────────────────────────────────────────────────────

// Matches Python's html.escape(s, quote=True) byte-for-byte.
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── Section extraction ───────────────────────────────────────────────

// Parse nav sections from topbar: nav-drop groups and standalone links.
//
// Two markup styles are supported because the project ships both:
//   - hand-written: <div class="nav-drop"><a class="nav-drop-trigger">Label</a>
//                   <div class="nav-drop-menu">...</div></div>
//   - lib/nav.mjs renderer: <span class="nav-drop"><span class="nav-drop-trigger">Label</span>
//                           <div class="nav-drop-menu">...</div></span>
// The trigger and the wrapper can each be either a/div OR span/span -
// regexes accept both so a renderer change in nav.mjs doesn't silently
// break sitemap section extraction.
export function extractSectionsFromTopbar(topbarHtml) {
  const sections = [];

  const dropRe =
    /<(?:a|span)[^>]+class="nav-drop-trigger"[^>]*>([\s\S]*?)<\/(?:a|span)>[\s\S]*?<div class="nav-drop-menu">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = dropRe.exec(topbarHtml)) !== null) {
    const label = m[1].trim();
    const menu = m[2];
    const hrefs = [];
    const hrefRe = /href="([^"]+\.html)"/g;
    let h;
    while ((h = hrefRe.exec(menu)) !== null) hrefs.push(h[1]);
    if (hrefs.length) sections.push([label, hrefs]);
  }

  // Standalone topbar links (not inside nav-drop, not index)
  const topbarLinksM = topbarHtml.match(
    /<nav class="topbar-links">([\s\S]*?)<\/nav>/,
  );
  if (topbarLinksM) {
    const navContent = topbarLinksM[1];
    // Remove nav-drop blocks to find standalone links. Match the wrapper
    // (div OR span) and skip up to the menu's closing </div> followed by
    // the wrapper's matching close tag.
    const stripped = navContent.replace(
      /<(div|span) class="nav-drop">[\s\S]*?<\/div>\s*<\/\1>/g,
      '',
    );
    const linkRe = /href="([^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
    let l;
    while ((l = linkRe.exec(stripped)) !== null) {
      const href = l[1];
      const text = l[2].trim();
      if (
        href !== 'index.html' &&
        href !== 'sitemap.html' &&
        href !== 'changelog.html'
      ) {
        sections.push([text, [href]]);
      }
    }
  }

  return sections;
}

// ── Page metadata extraction ─────────────────────────────────────────

export const EXCLUDE = new Set(['sitemap.html', '404.html']);

export function extractMeta(filePath) {
  const html = readFileSync(filePath, 'utf8');
  const titleM = html.match(/<title>([\s\S]*?)<\/title>/);
  const stem = path.basename(filePath, path.extname(filePath));
  let title = (titleM ? titleM[1] : stem).trim();
  // Remove project suffix from title, e.g. "About - Sample Project" -> "About".
  // Mirrors the Python regex `\s*[-\u2013\u2014]\s*\w[\w\s]*$`.
  title = title.replace(/\s*[-\u2013\u2014]\s*\w[\w\s]*$/u, '');
  title = title.replace(/&mdash;/g, '\u2014');

  const mainM = html.match(/<main[^>]*>([\s\S]*?)<\/main>/);
  const body = mainM ? mainM[1] : html;
  const pM = body.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  let summary = '';
  if (pM) {
    summary = pM[1].replace(/<[^>]+>/g, '');
    summary = summary.replace(/\s+/g, ' ').trim();
    if (summary.length > 180) {
      summary = summary.slice(0, 177).replace(/\s+$/, '') + '\u2026';
    }
  }
  return { title, summary };
}

// ── HTML output ──────────────────────────────────────────────────────

function renderCard(href, title, summary) {
  const summaryHtml = summary
    ? `<p style="color:var(--text-muted);font-size:13px;margin:6px 0 0;">${escapeHtml(summary)}</p>`
    : '';
  return (
    `<a class="card" href="${escapeHtml(href)}" ` +
    `style="display:block;text-decoration:none;color:inherit;">` +
    `<strong style="font-size:15px;color:var(--text);">${escapeHtml(title)}</strong>` +
    `${summaryHtml}</a>`
  );
}

export function buildHtml(docsDir, projectName, headHtml, topbarHtml, footerHtml) {
  const sections = extractSectionsFromTopbar(topbarHtml);
  const topbar = setActiveLink(topbarHtml, 'sitemap.html');

  const seen = new Set();
  const sectionsHtml = [];

  // Sections from topbar nav
  for (const [label, files] of sections) {
    const cards = [];
    for (const fname of files) {
      if (EXCLUDE.has(fname) || seen.has(fname)) continue;
      const p = path.join(docsDir, fname);
      if (!existsSync(p)) continue;
      seen.add(fname);
      const { title, summary } = extractMeta(p);
      cards.push(renderCard(fname, title, summary));
    }
    if (cards.length) {
      sectionsHtml.push(
        `<section><h2>${escapeHtml(label)}</h2>` +
          `<div class="grid-2">${cards.join('')}</div></section>`,
      );
    }
  }

  // index.html (if not already seen)
  if (!seen.has('index.html')) {
    const p = path.join(docsDir, 'index.html');
    if (existsSync(p)) {
      seen.add('index.html');
      const { title, summary } = extractMeta(p);
      const card = renderCard('index.html', title, summary);
      sectionsHtml.unshift(
        `<section><h2>Overview</h2><div class="grid-2">${card}</div></section>`,
      );
    }
  }

  // Pages not in any section
  const leftovers = [];
  const htmlFiles = readdirSync(docsDir)
    .filter((f) => f.endsWith('.html'))
    .sort();
  for (const name of htmlFiles) {
    if (EXCLUDE.has(name) || seen.has(name)) continue;
    const p = path.join(docsDir, name);
    const { title, summary } = extractMeta(p);
    leftovers.push(renderCard(name, title, summary));
  }
  if (leftovers.length) {
    sectionsHtml.push(
      `<section><h2>Other</h2>` +
        `<div class="grid-2">${leftovers.join('')}</div></section>`,
    );
  }

  const body = sectionsHtml.join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<meta name="googlebot" content="noindex, nofollow">
<title>${escapeHtml(projectName)} - Sitemap</title>
${headHtml}
</head>
<body>

${topbar}

<main class="container">
  <h1 class="doc-title">Sitemap</h1>
  <p style="color: var(--text-muted); margin-bottom: 24px;">Every page in the ${escapeHtml(projectName)} knowledge base, grouped by section. Auto-generated.</p>
  ${body}
</main>

${footerHtml}

<script>window.addEventListener("DOMContentLoaded",function(){var s=document.getElementById("search");if(!s)return;var mac=/Mac|iPhone|iPad|iPod/i.test(navigator.platform);var hint=mac?"\\u2318K":"Ctrl+K";if(typeof PagefindUI!=="undefined"){new PagefindUI({element:"#search",showSubResults:true,showImages:false,resetStyles:false,translations:{placeholder:"Search "+hint}});};document.addEventListener("keydown",function(e){var i=document.querySelector("#search input");if((e.metaKey||e.ctrlKey)&&(e.key==="k"||e.key==="K")){e.preventDefault();if(i){i.focus();i.select();}}else if(e.key==="Escape"&&i&&document.activeElement===i){i.blur();}});});</script>
<script src="/pagefind/pagefind-ui.js"></script>
</body>
</html>
`;
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

  const { projectName, headHtml, topbar, footer } = extractSiteChrome(docs);
  const html = buildHtml(docs, projectName, headHtml, topbar, footer);

  const output = path.join(docs, 'sitemap.html');
  writeFileSync(output, html);
  process.stdout.write(`Generated ${path.relative(repo, output)}\n`);
  return 0;
}

// Run as CLI when invoked directly.
const INVOKED_AS_CLI =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_AS_CLI) {
  process.exit(main());
}
