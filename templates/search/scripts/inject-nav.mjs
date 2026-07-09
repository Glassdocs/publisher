#!/usr/bin/env node
// Inject the topbar <nav class="topbar-links"> block from docs/nav.json
// into every HTML page that has a standard topbar.
//
// See lib/nav.mjs for the nav.json schema and validator. Active state is
// derived from each page's filename - no per-page config needed.
//
// Two lint checks run every invocation (also available via --check):
//   - coverage: every *.html in docs/ must appear in nav.json or navSkip
//   - targets:  every href in nav.json must resolve to a file in docs/
//
// Usage:
//   node inject-nav.mjs              # mutate + lint
//   node inject-nav.mjs --check      # lint only (no mutations)
//   node inject-nav.mjs --repo PATH  # explicit repo root

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNavConfig, renderNav, injectNav, lintNav } from './lib/nav.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { repo: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--check') out.check = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'usage: inject-nav.mjs [--repo PATH] [--check]\n'
      );
      process.exit(0);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // Default mirrors inject-search.py's historical default: two levels up
  // from the script. The deploy workflow always passes --repo `.` so this
  // only matters for local invocation.
  const repo = args.repo ? path.resolve(args.repo) : path.resolve(SCRIPT_DIR, '..');
  const docs = path.join(repo, 'docs');
  const navFile = path.join(docs, 'nav.json');

  if (!existsSync(docs)) {
    process.stderr.write(`docs/ directory not found at ${docs}\n`);
    return 1;
  }
  if (!existsSync(navFile)) {
    // Opt-in: KBs without a nav.json keep their hand-written topbar.
    const rel = path.relative(repo, navFile);
    process.stdout.write(`inject-nav: no ${rel} - skipping\n`);
    return 0;
  }

  const raw = readFileSync(navFile, 'utf8');
  const config = parseNavConfig(raw);
  if (!config) {
    process.stderr.write(`inject-nav: ${navFile} is not a valid NavConfig\n`);
    return 1;
  }

  const pages = readdirSync(docs).filter((f) => f.endsWith('.html')).sort();
  const errors = lintNav(pages, config);
  for (const e of errors) process.stderr.write(`${e}\n`);
  if (errors.length) return 1;
  if (args.check) {
    process.stdout.write('inject-nav: lint passed\n');
    return 0;
  }

  let changed = 0;
  for (const name of pages) {
    const file = path.join(docs, name);
    const before = readFileSync(file, 'utf8');
    if (!before.includes('<header class="topbar"')) continue;
    const navHtml = renderNav(config.items, name);
    const after = injectNav(before, navHtml);
    if (after !== before) {
      writeFileSync(file, after);
      changed++;
    }
  }
  process.stdout.write(`inject-nav: updated ${changed}/${pages.length} pages\n`);
  return 0;
}

process.exit(main());
