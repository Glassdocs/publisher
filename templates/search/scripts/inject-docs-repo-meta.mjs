#!/usr/bin/env node
// Inject <meta name="docs-repo" content="owner/name"> into <head> of
// every docs/*.html page. The Glassdocs browser extension reads this
// tag to know which GitHub repo backs the page (for "Edit on GitHub",
// commits, PRs, etc.).
//
// Auto-detects the GitHub repo from `git remote get-url origin`.
// Override with --docs-repo OWNER/NAME (the deploy workflow passes
// ${{ github.repository }} so the value is unambiguous in CI).
//
// Bails (warning, exit 0) if no GitHub repo can be determined - the
// deploy still succeeds, the site just won't drive the extension's
// write features. Read-only browsing keeps working without the tag.
//
// Idempotent: wraps output in <!-- @docs-repo-meta --> ...
// <!-- /@docs-repo-meta --> markers and replaces on rerun.
//
// Usage:
//   node inject-docs-repo-meta.mjs                            # auto-detect
//   node inject-docs-repo-meta.mjs --repo PATH                # explicit repo root
//   node inject-docs-repo-meta.mjs --repo PATH --docs-repo OWNER/NAME

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { escapeAttr, replaceOrInsertBlock } from './lib/inject-utils.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const START = '<!-- @docs-repo-meta -->';
export const END = '<!-- /@docs-repo-meta -->';

// ── CLI ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { repo: null, docsRepo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--docs-repo') out.docsRepo = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write(
        'usage: inject-docs-repo-meta.mjs [--repo PATH] [--docs-repo OWNER/NAME]\n',
      );
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
  // (https://github.com/Owner/Repo.git) style origins, plus an ssh://
  // URL scheme variant. Same regex shape as inject-page-meta.mjs.
  const m = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

// ── Shape validation ─────────────────────────────────────────────────

// GitHub allows alphanumerics, hyphen, underscore, and dot in owner
// and repo names. Reject anything else loudly rather than silently
// emitting a malformed meta tag - the extension's regex won't match
// it anyway, so failing here keeps the failure mode close to the cause.
export function isValidDocsRepo(spec) {
  return typeof spec === 'string' && /^[\w.-]+\/[\w.-]+$/.test(spec);
}

// ── Render the meta tag ──────────────────────────────────────────────

export function renderMeta(docsRepo) {
  return `${START}\n  <meta name="docs-repo" content="${escapeAttr(docsRepo)}">\n  ${END}`;
}

// ── Page-level injection ─────────────────────────────────────────────

/**
 * Returns { changed, html }. Idempotent on rerun. Inserts the marker
 * block immediately before </head>; if the page has no </head>, returns
 * the html unchanged (replaceOrInsertBlock handles that case).
 */
export function injectDocsRepoMeta(html, docsRepo) {
  const payload = renderMeta(docsRepo);
  return replaceOrInsertBlock(html, START, END, payload, /<\/head>/i, { before: true });
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

  const docsRepo = args.docsRepo ?? detectGithubRepo(repo);
  if (!docsRepo) {
    process.stderr.write(
      'inject-docs-repo-meta: no GitHub repo detected from git remote and no --docs-repo passed; skipping.\n',
    );
    return 0;
  }

  if (!isValidDocsRepo(docsRepo)) {
    process.stderr.write(
      `inject-docs-repo-meta: invalid docs-repo value "${docsRepo}" (expected OWNER/NAME)\n`,
    );
    return 1;
  }

  const files = readdirSync(docs).filter((f) => f.endsWith('.html'));
  let touched = 0;
  for (const name of files) {
    const p = path.join(docs, name);
    if (!statSync(p).isFile()) continue;
    const before = readFileSync(p, 'utf8');
    const { changed, html } = injectDocsRepoMeta(before, docsRepo);
    if (changed) {
      writeFileSync(p, html);
      touched++;
    }
  }
  process.stdout.write(
    `inject-docs-repo-meta: ${docsRepo} - touched ${touched}/${files.length} page(s)\n`,
  );
  return 0;
}

const INVOKED_AS_CLI =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_AS_CLI) {
  process.exit(main());
}
