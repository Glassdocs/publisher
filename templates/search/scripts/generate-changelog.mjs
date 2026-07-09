#!/usr/bin/env node
// Generate docs/changelog.html from git history.
//
// Project-agnostic: auto-detects project name and site chrome from
// docs/index.html via lib/chrome.mjs. Runs locally or via the Glassdocs
// reusable workflow.
//
// Usage:
//   node generate-changelog.mjs              # auto-detect repo root
//   node generate-changelog.mjs --repo PATH  # explicit repo root

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
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
      process.stdout.write('usage: generate-changelog.mjs [--repo PATH]\n');
      process.exit(0);
    }
  }
  return out;
}

// ── HTML escaping ────────────────────────────────────────────────────
// Matches Python's html.escape(s) default (quote=True): & < > " '.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ── Git history ──────────────────────────────────────────────────────

function runGit(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

export function getCommits(repo) {
  // fetch --unshallow fails silently when the repo is already complete.
  runGit(['fetch', '--unshallow'], repo);

  const revList = runGit(['rev-list', 'HEAD'], repo);
  if (revList.status !== 0) {
    process.stderr.write(`git rev-list failed: ${revList.stderr}\n`);
    process.exit(1);
  }

  const shas = revList.stdout
    .trim()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const commits = [];
  for (const sha of shas) {
    const meta = runGit(
      ['log', '-1', '--format=%aI%x09%s%x09%b', sha],
      repo,
    );
    // Mirror Python's `meta.stdout.split("\t", 2)` - split on the first two
    // tabs so that body tabs (if any) are preserved. Body is then stripped
    // just like Python does via parts[2].strip().
    const raw = meta.stdout;
    const firstTab = raw.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = raw.indexOf('\t', firstTab + 1);
    const dateStr = raw.slice(0, firstTab);
    let subject;
    let body;
    if (secondTab === -1) {
      subject = raw.slice(firstTab + 1);
      // Git terminates log output with a newline; strip it so subject
      // matches Python's split output (which keeps subject bare).
      if (subject.endsWith('\n')) subject = subject.slice(0, -1);
      body = '';
    } else {
      subject = raw.slice(firstTab + 1, secondTab);
      body = raw.slice(secondTab + 1).trim();
    }

    // --root ensures the initial commit's files are included (without
    // --root, git diff-tree returns empty output for commits with no parent).
    const filesResult = runGit(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha],
      repo,
    );
    const files = filesResult.stdout
      .trim()
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);

    commits.push({ sha, date: dateStr, subject, body, files });
  }
  return commits;
}

// ── Filtering ────────────────────────────────────────────────────────

const SELF_PATH = 'docs/changelog.html';

// All commit-message directives that GitHub Actions treats as "skip CI"
// for push events. Documented at:
//   https://docs.github.com/en/actions/managing-workflow-runs/skipping-workflow-runs
// They are case-sensitive in GitHub's matching, so we keep them case-
// sensitive too. The directives can appear anywhere in the commit
// message, not just the subject.
const SKIP_CI_DIRECTIVES = [
  '[skip ci]',
  '[ci skip]',
  '[no ci]',
  '[skip actions]',
  '[actions skip]',
  '***NO_CI***',
];

export function isSkipCi(commit) {
  // The commit message is subject + (optional) body. Either part can
  // carry the directive. Concatenate before scanning so we don't have
  // to repeat the loop twice.
  const message = commit.body
    ? `${commit.subject}\n${commit.body}`
    : commit.subject;
  for (const tag of SKIP_CI_DIRECTIVES) {
    if (message.includes(tag)) return true;
  }
  return false;
}

export function filterCommits(commits) {
  const filtered = [];
  for (const c of commits) {
    if (isSkipCi(c)) continue;
    const nonSelf = c.files.filter((f) => f !== SELF_PATH);
    if (nonSelf.length > 0) {
      filtered.push({ ...c, files: nonSelf });
    }
  }
  return filtered;
}

// ── Categorisation ───────────────────────────────────────────────────

export function categoriseFiles(files) {
  const categories = {
    Pages: [],
    Scripts: [],
    Styles: [],
    Documents: [],
    Sources: [],
    Workflows: [],
    Other: [],
  };
  for (const f of files) {
    const name = f.toLowerCase();
    if (name.endsWith('.pdf') || name.endsWith('.docx')) {
      categories.Documents.push(f);
    } else if (f.startsWith('docs/') && f.endsWith('.html')) {
      categories.Pages.push(f);
    } else if (
      name.endsWith('.py') ||
      name.endsWith('.mjs') ||
      name.endsWith('.js') ||
      name.endsWith('.sh')
    ) {
      categories.Scripts.push(f);
    } else if (name.endsWith('.css')) {
      categories.Styles.push(f);
    } else if (f.startsWith('sources/')) {
      categories.Sources.push(f);
    } else if (f.startsWith('.github/')) {
      categories.Workflows.push(f);
    } else {
      categories.Other.push(f);
    }
  }
  // Prune empty buckets but preserve insertion order.
  const out = {};
  for (const k of Object.keys(categories)) {
    if (categories[k].length > 0) out[k] = categories[k];
  }
  return out;
}

// ── Date formatting ──────────────────────────────────────────────────

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                   'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Parse an ISO 8601 timestamp with either `Z` or `+HH:MM`/`-HH:MM` offset.
// Returns a UTC Date, or null if parsing fails. Accepts the Z suffix even
// though early Python releases (< 3.11) choked on it - that was the bug
// that motivated this permissive parser.
function parseIsoDate(s) {
  const m = String(s).match(
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, , tz] = m;
  let offsetMin;
  if (tz === 'Z' || tz === 'z') {
    offsetMin = 0;
  } else {
    const sign = tz[0] === '-' ? -1 : 1;
    const oh = parseInt(tz.slice(1, 3), 10);
    const om = parseInt(tz.slice(4, 6), 10);
    offsetMin = sign * (oh * 60 + om);
  }
  const utcMs = Date.UTC(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    parseInt(hh, 10),
    parseInt(mm, 10),
    parseInt(ss, 10),
  ) - offsetMin * 60 * 1000;
  const out = new Date(utcMs);
  if (Number.isNaN(out.getTime())) return null;
  return out;
}

const AEST_OFFSET_MIN = 11 * 60; // UTC+11, matching the Python module.

export function formatDate(isoDate) {
  const dt = parseIsoDate(isoDate);
  if (!dt) {
    // Python falls back to the first 10 chars on parse failure.
    return String(isoDate).slice(0, 10);
  }
  // Shift to AEST by adding the offset, then read UTC components so the
  // formatted string reflects AEST wall-clock regardless of system TZ.
  const shifted = new Date(dt.getTime() + AEST_OFFSET_MIN * 60 * 1000);
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  const mon = MONTHS_EN[shifted.getUTCMonth()];
  const yyyy = shifted.getUTCFullYear();
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${dd} ${mon} ${yyyy}, ${hh}:${mm}`;
}

// ── HTML output ──────────────────────────────────────────────────────

export function buildHtml(commits, projectName, headHtml, topbarHtml, footerHtml) {
  const rows = [];
  for (const c of commits) {
    const date = formatDate(c.date);
    const shaShort = c.sha.slice(0, 7);
    const subject = escapeHtml(c.subject);

    const bodyLines = (c.body || '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('Co-Authored-By:'));
    const body = escapeHtml(bodyLines.join('\n').trim());

    const cats = categoriseFiles(c.files);
    let fileBadges = '';
    for (const cat of Object.keys(cats)) {
      const files = cats[cat];
      let fileList = files.slice(0, 5).map((f) => f.split('/').pop()).join(', ');
      if (files.length > 5) fileList += ` +${files.length - 5} more`;
      fileBadges +=
        '<span style="display:inline-block;background:var(--surface2);' +
        'padding:2px 8px;border-radius:4px;font-size:11px;margin-right:6px;' +
        `margin-bottom:4px;">${cat}: ${escapeHtml(fileList)}</span>`;
    }

    const bodyHtml = body
      ? `<p style="color:var(--text-muted);font-size:13px;margin:6px 0 0;white-space:pre-wrap;">${body}</p>`
      : '';

    rows.push(`
    <div class="card" style="padding:16px 20px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;gap:16px;">
        <strong style="font-size:15px;">${subject}</strong>
        <span style="color:var(--text-muted);font-size:12px;white-space:nowrap;">${date}</span>
      </div>
      <div style="margin-top:6px;">${fileBadges}</div>
      <code style="font-size:11px;color:var(--text-muted);">${shaShort}</code>${bodyHtml}
    </div>`);
  }

  const entries = rows.join('\n');
  const count = commits.length;
  const topbar = setActiveLink(topbarHtml, 'changelog.html');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
<meta name="googlebot" content="noindex, nofollow">
<title>${escapeHtml(projectName)} - Changelog</title>
${headHtml}
</head>
<body>

${topbar}

<nav class="sidebar" id="sidebar">
  <div class="nav-group">
    <div class="nav-group-title">Changelog</div>
    <a href="#log">All Changes (${count})</a>
  </div>
</nav>

<main class="content">

  <h1 class="doc-title">Changelog</h1>
  <p style="color: var(--text-muted); margin-bottom: 24px;">All changes to the ${escapeHtml(projectName)} knowledge base, auto-generated from git history. ${count} commits.</p>

  <section id="log">
${entries}
  </section>

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
  const repo = args.repo ? path.resolve(args.repo) : path.resolve(SCRIPT_DIR, '..');
  const docs = path.join(repo, 'docs');

  if (!existsSync(docs)) {
    process.stderr.write(`docs/ directory not found at ${docs}\n`);
    return 1;
  }

  const { projectName, headHtml, topbar, footer } = extractSiteChrome(docs);
  let commits = getCommits(repo);
  commits = filterCommits(commits);
  const html = buildHtml(commits, projectName, headHtml, topbar, footer);

  const output = path.join(docs, 'changelog.html');
  writeFileSync(output, html);
  process.stdout.write(`Generated ${path.relative(repo, output)} (${commits.length} commits)\n`);
  return 0;
}

const invokedDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirect) {
  process.exit(main());
}
