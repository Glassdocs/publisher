#!/usr/bin/env node
// Generate docs/references/index.html from docs/references/manifest.json.
//
// Run as a deploy step; the Cloudflare Pages workflow then publishes the
// generated file along with the rest of docs/. No-ops silently when no
// manifest is present (repos without a KB references page).
//
// Validation rules (fail the build if violated):
//   - every file in docs/references/ (except manifest.json,
//     manifest.schema.json, index.html) must appear in the manifest
//   - every manifest entry must reference a file that exists on disk
//   - every manifest entry must have a title
//
// Usage:
//   node generate-references.mjs              # auto-detect repo root
//   node generate-references.mjs --repo PATH  # explicit repo root
//
// Ported from generate-references.py. This generator is self-contained
// (unlike sitemap/changelog) - it builds its own chrome directly under
// docs/references/ and does not use lib/chrome.mjs.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const META_FILES = new Set(['manifest.json', 'manifest.schema.json', 'index.html']);

// ── HTML / URL helpers ───────────────────────────────────────────────
//
// Byte-for-byte compatible with Python's `html.escape(s, quote=True)` and
// `urllib.parse.quote(s)` (default safe='/').

export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Mirror urllib.parse.quote default (safe='/'): percent-encode every byte
// except RFC 3986 unreserved chars (A-Z a-z 0-9 - _ . ~) plus '/'.
// JS encodeURIComponent does not encode '!', "'", '(', ')', '*' but
// urllib.parse.quote does - patch those. urlllib.parse.quote also preserves
// '/' where encodeURIComponent encodes it as %2F, so post-process that too.
export function quote(s) {
  if (s === null || s === undefined) return '';
  // encodeURIComponent operates on UTF-8 for non-ASCII which matches
  // urllib.parse.quote's default utf-8 encoding.
  let out = encodeURIComponent(String(s));
  // Restore '/' - urllib.parse.quote has safe='/' by default.
  out = out.replace(/%2F/g, '/');
  // Patch the sub-delims that encodeURIComponent leaves untouched but
  // urllib.parse.quote percent-encodes.
  out = out
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
  return out;
}

// ── Validation ───────────────────────────────────────────────────────

export function validate(entries, referencesDir) {
  const errors = [];
  const diskFiles = new Set();
  for (const name of readdirSync(referencesDir)) {
    const p = path.join(referencesDir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isFile() && !META_FILES.has(name)) {
      diskFiles.add(name);
    }
  }

  for (const entry of entries) {
    const fname = entry && entry.file;
    if (!fname) {
      errors.push(`entry missing 'file' field: ${JSON.stringify(entry)}`);
      continue;
    }
    if (!entry.title) {
      errors.push(`entry for '${fname}' is missing 'title'`);
    }
    if (!existsSync(path.join(referencesDir, fname))) {
      errors.push(`manifest references missing file: ${fname}`);
    } else {
      diskFiles.delete(fname);
    }
  }

  const orphans = Array.from(diskFiles).sort();
  for (const orphan of orphans) {
    errors.push(`file in docs/references/ is not listed in manifest.json: ${orphan}`);
  }
  return errors;
}

// ── Rendering ────────────────────────────────────────────────────────

export function renderRows(entries) {
  // Python: sorted(entries, key=lambda e: e.get("uploaded_at") or "", reverse=True)
  // Python's sort is stable; Array.prototype.sort is stable since ES2019.
  const sorted = entries.slice().sort((a, b) => {
    const av = (a && a.uploaded_at) || '';
    const bv = (b && b.uploaded_at) || '';
    if (av < bv) return 1;
    if (av > bv) return -1;
    return 0;
  });

  const rows = [];
  for (const e of sorted) {
    // Coerce to [] when tags is missing OR a non-array truthy value
    // (e.g. a comma-string a user might paste in - the bare `|| []`
    // fallback only catches falsy values, so a string would slip
    // through and crash the .map call below).
    const tags = Array.isArray(e?.tags) ? e.tags : [];
    const tagsHtml = tags
      .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
      .join(' ');
    const href = quote(e.file);
    const title = escapeHtml(e.title);
    const description = escapeHtml(e.description || '');
    const uploadedAt = escapeHtml(e.uploaded_at || '');
    rows.push(
      '    <tr>\n' +
        `      <td><a href="${href}" download>${title}</a></td>\n` +
        `      <td>${description}</td>\n` +
        `      <td>${uploadedAt}</td>\n` +
        `      <td>${tagsHtml}</td>\n` +
        '    </tr>',
    );
  }
  return rows.join('\n');
}

export function buildHtml(entries) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <meta name="googlebot" content="noindex, nofollow">
  <title>References</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="topbar">
    <h1>
      <a href="/index.html"><img src="/logo.svg" alt="Rocket Lab" class="topbar-logo"></a>
      <span class="badge">References</span>
    </h1>
  </header>
  <main>
    <h2>Knowledge Base References</h2>
    <p>Downloadable source materials and attachments for this project.</p>
    <table class="references">
      <thead>
        <tr><th>File</th><th>Description</th><th>Added</th><th>Tags</th></tr>
      </thead>
      <tbody>
${renderRows(entries)}
      </tbody>
    </table>
  </main>
  <footer>
    <p>Auto-generated from <code>docs/references/manifest.json</code>.</p>
  </footer>
</body>
</html>
`;
}

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: generate-references.mjs [--repo PATH]\n');
      process.exit(0);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo
    ? path.resolve(args.repo)
    : path.resolve(SCRIPT_DIR, '..');
  const referencesDir = path.join(repo, 'docs', 'references');
  const manifestPath = path.join(referencesDir, 'manifest.json');
  const indexPath = path.join(referencesDir, 'index.html');

  if (!existsSync(manifestPath)) {
    // Match Python output: "[generate-references] no manifest.json - skipping"
    // Use a hyphen, not an em dash, per repo style (AI tell).
    process.stdout.write('[generate-references] no manifest.json - skipping\n');
    return 0;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    process.stderr.write(
      `[generate-references] manifest.json is not valid JSON: ${err.message}\n`,
    );
    return 1;
  }
  // Defensive coercion: a malformed manifest where `references` is set
  // but not an array (e.g. a typo'd object {} or a string) would slip
  // past `|| []` and crash later in validate / renderRows. Surface the
  // shape error here with a clear message instead.
  const rawRefs = manifest && manifest.references;
  if (rawRefs !== undefined && rawRefs !== null && !Array.isArray(rawRefs)) {
    process.stderr.write(
      `[generate-references] manifest.json: 'references' must be an array, got ${typeof rawRefs}\n`,
    );
    return 1;
  }
  const entries = Array.isArray(rawRefs) ? rawRefs : [];

  const errors = validate(entries, referencesDir);
  if (errors.length) {
    process.stderr.write('[generate-references] validation failed:\n');
    for (const e of errors) {
      process.stderr.write(`  - ${e}\n`);
    }
    return 1;
  }

  writeFileSync(indexPath, buildHtml(entries));
  const rel = path.relative(repo, indexPath).split(path.sep).join('/');
  process.stdout.write(
    `[generate-references] wrote ${rel} (${entries.length} entry(ies))\n`,
  );
  return 0;
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (isMain) {
  process.exit(main());
}
