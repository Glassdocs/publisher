// ──────────────────────────────────────────────────────────────────────
// harness.mjs — hermetic scaffolding for the publisher's shell scripts.
//
// Every test gets its own temp dir containing:
//   bin/curl        an executable shim that execs helpers/mock-curl.mjs
//   curl-script.json the scripted Cloudflare responses
//   curl-log.jsonl   the recorded requests
//
// bin/ is prepended to PATH, so the scripts hit the mock even where they call
// `curl` by name. Nothing in this suite touches the network, git remotes, or a
// real Cloudflare account.
// ──────────────────────────────────────────────────────────────────────
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..");
export const SCRIPTS = path.join(REPO, "templates", "search", "scripts");
export const SYNC_SCRIPT = path.join(SCRIPTS, "sync-access-policies.sh");
export const LINT_SCRIPT = path.join(SCRIPTS, "docs-lint.sh");
export const INJECT_SCRIPT = path.join(SCRIPTS, "inject-source-meta.mjs");
export const WORKFLOW = path.join(REPO, ".github", "workflows", "deploy-pages.yml");

// The scripts declare `#!/usr/bin/env bash` and CI runs bash 5. macOS ships
// bash 3.2 as /bin/bash; set BASH_BIN to point at a newer one locally.
export const BASH = process.env.BASH_BIN || "bash";

// A script under test must never outlive this. Guards against a pagination or
// retry loop that stops terminating: the test fails in seconds instead of
// hanging the suite (and CI) forever.
const SCRIPT_TIMEOUT_MS = 30_000;

const ACCOUNT_ID = "acct-test";
export const APP_ID = "app-test";
export const POLICIES_PATH = `/client/v4/accounts/${ACCOUNT_ID}/access/apps/${APP_ID}/policies`;

/** A Cloudflare list-policies response. */
export function policyList(policies, { total_pages = 1, page = 1 } = {}) {
  return {
    success: true,
    errors: [],
    result: policies,
    result_info: { page, per_page: 50, count: policies.length, total_pages },
  };
}

export function policy(id, name, precedence) {
  return { id, name, precedence, decision: "allow", include: [] };
}

/**
 * Build an isolated sandbox: mock curl on PATH + a request log.
 * `routes` is the mock-curl route table (see helpers/mock-curl.mjs).
 */
export function sandbox(routes = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "gd-pub-test-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir);

  const shim = path.join(binDir, "curl");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(HERE, "mock-curl.mjs")}" "$@"\n`, {
    mode: 0o755,
  });

  const scriptFile = path.join(dir, "curl-script.json");
  const logFile = path.join(dir, "curl-log.jsonl");
  writeFileSync(scriptFile, JSON.stringify({ routes }, null, 2));
  writeFileSync(logFile, "");

  return {
    dir,
    env: {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: dir,
      MOCK_CURL_SCRIPT: scriptFile,
      MOCK_CURL_LOG: logFile,
    },
    /** Every recorded request, in order. */
    requests() {
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l));
    },
    /** Compact "METHOD /path?query" strings — the assertable call sequence. */
    calls() {
      return this.requests().map((r) => `${r.method} ${r.path}${r.query ? `?${r.query}` : ""}`);
    },
    /** Just the HTTP verbs, for ordering assertions. */
    methods() {
      return this.requests().map((r) => r.method);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Run sync-access-policies.sh inside a sandbox. */
export function runSync(sb, env = {}) {
  const res = spawnSync(BASH, [SYNC_SCRIPT], {
    env: {
      ...sb.env,
      CLOUDFLARE_API_TOKEN: "tok-test",
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
      APP_ID,
      ...env,
    },
    encoding: "utf8",
    timeout: SCRIPT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return decorate(res);
}

/**
 * The dedented `run:` script of a named workflow step.
 *
 * Extracted rather than copied so the suite executes the SHIPPED text — a step
 * whose logic is re-typed into a test fixture is a test of the fixture. Throws
 * if the step or its `run:` block can't be found, so a rename fails loudly
 * instead of silently testing nothing.
 */
export function workflowStep(name, file = WORKFLOW) {
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start === -1) throw new Error(`workflowStep: no step named ${JSON.stringify(name)} in ${file}`);

  const stepIndent = lines[start].indexOf("- name:");
  let runAt = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    const indent = l.length - l.trimStart().length;
    // Dedented back to the step list — we left the step without finding `run:`.
    if (indent <= stepIndent) break;
    if (/^run:\s*\|/.test(l.trim())) {
      runAt = i;
      break;
    }
  }
  if (runAt === -1) throw new Error(`workflowStep: step ${JSON.stringify(name)} has no 'run: |' block`);

  const runIndent = lines[runAt].length - lines[runAt].trimStart().length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) {
      body.push("");
      continue;
    }
    const indent = l.length - l.trimStart().length;
    if (indent <= runIndent) break;
    body.push(l.slice(runIndent + 2));
  }
  return body.join("\n").replace(/\s+$/, "") + "\n";
}

/**
 * Run a workflow step's script inside a sandbox, with the propagation waits
 * collapsed. The VERIFY_* overrides are declared in the workflow itself and
 * default to the shipped values — see the seam comment there.
 */
export function runStep(sb, script, env = {}) {
  const file = path.join(sb.dir, "step.sh");
  writeFileSync(file, script);
  const res = spawnSync(BASH, [file], {
    env: {
      ...sb.env,
      VERIFY_SETTLE_SECONDS: "0",
      VERIFY_POLL_SECONDS: "0",
      VERIFY_BUDGET_SECONDS: "0",
      VERIFY_REPROBE_SECONDS: "0",
      ...env,
    },
    encoding: "utf8",
    timeout: SCRIPT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return decorate(res);
}

/** Run docs-lint.sh with `cwd` as the repo root. */
export function runLint(cwd, env = {}) {
  const res = spawnSync(BASH, [LINT_SCRIPT], {
    cwd,
    env: { PATH: process.env.PATH, HOME: cwd, ...env },
    encoding: "utf8",
    timeout: SCRIPT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return decorate(res);
}

/** Run inject-source-meta.mjs as a CLI with `cwd` as the repo root. */
export function runInject(cwd, args) {
  const res = spawnSync(process.execPath, [INJECT_SCRIPT, ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: cwd },
    encoding: "utf8",
    timeout: SCRIPT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return decorate(res);
}

function decorate(res) {
  const timedOut = res.signal === "SIGKILL" || res.error?.code === "ETIMEDOUT";
  return {
    ...res,
    timedOut,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}${timedOut ? `\n[harness] script did not terminate within ${SCRIPT_TIMEOUT_MS}ms` : ""}`,
  };
}

/** Create a throwaway directory tree from a {relPath: contents} map. */
export function fixtureTree(files, { git = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "gd-pub-fx-"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
  }
  if (git) {
    const opts = { cwd: dir, encoding: "utf8" };
    spawnSync("git", ["init", "-q"], opts);
    spawnSync("git", ["config", "user.email", "t@example.com"], opts);
    spawnSync("git", ["config", "user.name", "t"], opts);
    // `git ls-files` reads the index, so staging is enough — no commit needed.
    for (const rel of Object.keys(git === true ? files : git)) {
      spawnSync("git", ["add", "--", rel], opts);
    }
  }
  return dir;
}

export function stage(dir, rel) {
  spawnSync("git", ["add", "--", rel], { cwd: dir, encoding: "utf8" });
}

export function isGitRepo(dir) {
  return spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir, encoding: "utf8" }).status === 0;
}

export { existsSync };
