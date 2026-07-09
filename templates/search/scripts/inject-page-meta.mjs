#!/usr/bin/env node
// Inject per-page metadata into every docs/*.html footer:
//   - Last-updated stamp from git history
//   - "Edit on GitHub" link
//
// Project-agnostic: auto-detects GitHub repo from git remote.
// Idempotent: wraps output in HTML comment markers and replaces on rerun.
//
// Usage:
//   node inject-page-meta.mjs              # auto-detect repo root
//   node inject-page-meta.mjs --repo PATH  # explicit repo root

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { escapeAttr, escapeText, escapeRegExp } from './lib/inject-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const START = '<!-- @page-meta -->';
export const END = '<!-- /@page-meta -->';
export const BRANCH = 'main';

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: inject-page-meta.mjs [--repo PATH]\n');
      process.exit(0);
    }
  }
  return out;
}

// ── Auto-detection ───────────────────────────────────────────────────

export function detectGithubRepo(repoDir) {
  const res = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  const url = (res.stdout || '').trim();
  if (!url) return null;

  // Matches both SSH (git@github.com:Owner/Repo.git) and HTTPS
  // (https://github.com/Owner/Repo.git) style origins, and an ssh://
  // URL scheme variant used by some hosts.
  const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (m) return m[1];
  return null;
}

// ── Metadata injection ───────────────────────────────────────────────

export function formatAest(iso) {
  // Mirrors the Python behaviour:
  //   - Parse an ISO-8601 timestamp (tolerating a trailing 'Z').
  //   - Render as DD MMM YYYY in AEST (UTC+11, fixed - matches the Python
  //     which uses a fixed offset rather than zone-aware DST).
  //   - On any parse failure, fall back to the first 10 chars of the ISO
  //     input (the YYYY-MM-DD prefix).
  if (!iso) return null;
  // Normalise 'Z' suffix to an explicit offset. JS Date does accept 'Z'
  // natively, but we also want the path to work on the occasional input
  // that only has partial precision. This mirrors the bugfix in the
  // Python version for the same class of inputs.
  const normalised = iso.endsWith('Z') ? iso.slice(0, -1) + '+00:00' : iso;
  const ms = Date.parse(normalised);
  if (Number.isNaN(ms)) {
    return iso.slice(0, 10);
  }
  // Shift to AEST (UTC+11) by adding the offset to the UTC clock and
  // reading the UTC components back.
  const shifted = new Date(ms + 11 * 60 * 60 * 1000);
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  const month = months[shifted.getUTCMonth()];
  const year = shifted.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

export function lastUpdated(repoDir, pagePath) {
  const rel = path.relative(repoDir, pagePath).split(path.sep).join('/');
  const res = spawnSync('git', ['log', '-1', '--format=%aI', '--', rel], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  const iso = (res.stdout || '').trim();
  if (!iso) return null;
  return formatAest(iso);
}

// Per-segment URL-encode: a docs filename can legally contain `?`, `#`,
// `&`, spaces, etc. Those would otherwise be reinterpreted by GitHub
// as a query string / fragment / wrong-path. encodeURIComponent on
// the whole repo+path would also encode the slashes, so we split,
// encode each segment, and rejoin.
function encodePathSegments(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

export function renderMeta(githubRepo, relPath, updated) {
  const updatedHtml = updated
    ? `<span class="page-meta__updated">Updated ${escapeText(updated)}</span>`
    : '';

  let editHtml = '';
  if (githubRepo) {
    // githubRepo is "Owner/Repo" - GitHub repo and owner names only allow
    // alphanumerics, dot, dash, underscore, so URL-encoding is identity
    // here in practice. Still safer to encode each segment.
    const repoSegments = githubRepo.split('/').map(encodeURIComponent).join('/');
    const editUrl = `https://github.com/${repoSegments}/edit/${encodeURIComponent(BRANCH)}/${encodePathSegments(relPath)}`;
    editHtml =
      `<a class="page-meta__edit" href="${escapeAttr(editUrl)}" ` +
      `target="_blank" rel="noopener">Edit on GitHub \u2192</a>`;
  }

  return (
    `${START}\n` +
    `  <div class="page-meta">` +
    `${updatedHtml}` +
    `${editHtml}` +
    `</div>\n` +
    `  ${END}`
  );
}

export function inject(html, meta) {
  const markerPattern = new RegExp(
    escapeRegExp(START) + '[\\s\\S]*?' + escapeRegExp(END),
  );
  if (markerPattern.test(html)) {
    // Use function replace to avoid $-substitution surprises in `meta`.
    return html.replace(markerPattern, () => meta);
  }

  if (html.includes('<footer')) {
    const footerPattern = /(<footer[^>]*>)([\s\S]*?)(<\/footer>)/;
    return html.replace(footerPattern, (_, open, inner, close) => {
      const innerTrimmed = inner.replace(/\s+$/, '');
      return `${open}${innerTrimmed}\n  ${meta}\n${close}`;
    });
  }

  const idx = html.indexOf('</body>');
  if (idx === -1) return html;
  return (
    html.slice(0, idx) +
    `<footer>\n  ${meta}\n</footer>\n` +
    html.slice(idx)
  );
}

// ── main ─────────────────────────────────────────────────────────────

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

  const githubRepo = detectGithubRepo(repo);
  if (!githubRepo) {
    process.stderr.write(
      'Warning: could not detect GitHub repo from git remote\n',
    );
  }

  const pages = readdirSync(docs)
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => path.join(docs, f));
  if (pages.length === 0) {
    process.stderr.write('No HTML pages found\n');
    return 1;
  }

  let changed = 0;
  for (const page of pages) {
    const rel = path.relative(repo, page).split(path.sep).join('/');
    const meta = renderMeta(githubRepo, rel, lastUpdated(repo, page));
    const before = readFileSync(page, 'utf8');
    const after = inject(before, meta);
    if (after !== before) {
      writeFileSync(page, after);
      changed++;
    }
  }
  process.stdout.write(
    `inject-page-meta: updated ${changed}/${pages.length} pages\n`,
  );
  return 0;
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  process.exit(main());
}
