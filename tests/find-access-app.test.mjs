// ──────────────────────────────────────────────────────────────────────
// The Access-app matcher jq from deploy-pages.yml.
//
// This expression decides which Cloudflare Access app gates a KB's domain. Get
// it wrong in one direction and the workflow creates a DUPLICATE app beside the
// real one (policies land on the wrong app; the site keeps the old rules). Get
// it wrong in the other and public mode deletes the wrong app. It has already
// had a dead `.domain` branch, so it is tested against fixtures directly.
//
// The expressions live as verbatim copies under fixtures/*.jq — see the header
// of fixtures/find-access-app.jq for why they are copies rather than files the
// workflow references. The drift guards at the bottom of this file fail if a
// copy and the workflow ever diverge.
// ──────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO } from "./helpers/harness.mjs";

const FIXTURES = path.join(REPO, "tests", "fixtures");
const WORKFLOW = readFileSync(path.join(REPO, ".github", "workflows", "deploy-pages.yml"), "utf8");
const DOMAIN = "kb-acme.pages.dev";

function jq(file, input, { args = [], raw = true } = {}) {
  const res = spawnSync("jq", [...(raw ? ["-r"] : ["-c"]), ...args, "-f", path.join(FIXTURES, file)], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `jq failed: ${res.stderr}`);
  return res.stdout.split("\n").filter((l) => l !== "");
}

/** Run the matcher exactly as the workflow does. */
function match(response, domain = DOMAIN) {
  return jq("find-access-app.jq", response, { args: ["--arg", "d", domain] });
}

const list = (...apps) => ({ success: true, result: apps, result_info: { total_pages: 1 } });

// ── App shapes Cloudflare actually returns ────────────────────────────

test("an app listing the domain in self_hosted_domains matches", () => {
  const apps = list({ id: "app-shd", name: "acme", domain: DOMAIN, self_hosted_domains: [DOMAIN, `*.${DOMAIN}`] });
  assert.deepEqual(match(apps), ["app-shd"]);
});

test("a destinations-only app (no self_hosted_domains at all) matches on the destination uri", () => {
  const apps = list({ id: "app-dest", name: "acme", destinations: [{ type: "public", uri: DOMAIN }] });
  assert.deepEqual(match(apps), ["app-dest"]);
});

test("an apex-only app matches through the .domain fallback (this branch is NOT dead code)", () => {
  // Older apps carry only `domain`. Losing this branch means the workflow
  // decides no app exists and creates a duplicate beside the live one.
  const apps = list({ id: "app-apex", name: "acme", domain: DOMAIN });
  assert.deepEqual(match(apps), ["app-apex"]);
});

test("an app that matches in BOTH self_hosted_domains and destinations yields exactly one id", () => {
  const apps = list({
    id: "app-both",
    domain: DOMAIN,
    self_hosted_domains: [DOMAIN],
    destinations: [{ type: "public", uri: DOMAIN }],
  });
  assert.deepEqual(match(apps), ["app-both"], "a duplicated id would make `head -1` mask a second matching app");
});

test("no app gating the domain yields no output at all", () => {
  const apps = list(
    { id: "other-1", domain: "someone-else.pages.dev", self_hosted_domains: ["someone-else.pages.dev"] },
    { id: "other-2", destinations: [{ type: "public", uri: "nope.pages.dev" }] },
  );
  assert.deepEqual(match(apps), []);
});

test("each matching app contributes exactly one id, in list order", () => {
  const apps = list(
    { id: "no-match", domain: "x.pages.dev" },
    { id: "first", self_hosted_domains: [DOMAIN] },
    { id: "second", destinations: [{ type: "public", uri: DOMAIN }] },
  );
  assert.deepEqual(match(apps), ["first", "second"]);
});

// ── Matching must be exact, never fuzzy ───────────────────────────────

test("a wildcard entry alone does not match the apex domain", () => {
  // *.kb-acme.pages.dev gates previews, not the apex. Matching it would let the
  // workflow adopt an app that does not actually gate the site.
  const apps = list({ id: "wild", self_hosted_domains: [`*.${DOMAIN}`] });
  assert.deepEqual(match(apps), []);
});

test("a domain that merely CONTAINS ours does not match", () => {
  const apps = list(
    { id: "sub", self_hosted_domains: [`staging.${DOMAIN}`] },
    { id: "sup", self_hosted_domains: [`${DOMAIN}.evil.example`] },
  );
  assert.deepEqual(match(apps), []);
});

test("a destination uri carrying a path or scheme does not match the bare domain", () => {
  // Documents the boundary: the matcher compares whole strings, so a
  // destinations entry stored as a URL is invisible to it.
  const apps = list({ id: "url-form", destinations: [{ type: "public", uri: `https://${DOMAIN}` }] });
  assert.deepEqual(match(apps), []);
});

// ── Degenerate API payloads must not crash the step ───────────────────

test("a response with no result array produces no output instead of an error", () => {
  assert.deepEqual(match({ success: true }), []);
  assert.deepEqual(match({ success: true, result: null }), []);
  assert.deepEqual(match({ success: true, result: [] }), []);
});

test("an app with null self_hosted_domains and null destinations is skipped, not fatal", () => {
  const apps = list({ id: "nulls", domain: null, self_hosted_domains: null, destinations: null });
  assert.deepEqual(match(apps), []);
});

// ── Preview-wildcard back-fill (the fix that only applied to NEW apps) ─

function hasWildcard(app, domain = DOMAIN) {
  return jq("has-wildcard.jq", app, { args: ["--arg", "w", `*.${domain}`] }).join("");
}

test("an existing app WITHOUT the preview wildcard is detected as needing the back-fill", () => {
  assert.equal(hasWildcard({ id: "a", domain: DOMAIN, self_hosted_domains: [DOMAIN] }), "");
});

test("an app that already has the preview wildcard is left alone (the back-fill is idempotent)", () => {
  assert.equal(hasWildcard({ id: "a", self_hosted_domains: [DOMAIN, `*.${DOMAIN}`] }), "yes");
  assert.equal(hasWildcard({ id: "a", destinations: [{ type: "public", uri: `*.${DOMAIN}` }] }), "yes");
});

test("the back-fill PUT body keeps the apex domain and appends the wildcard", () => {
  const [body] = jq("wildcard-put-body.jq", {
    id: "a",
    name: "acme",
    domain: DOMAIN,
    type: "self_hosted",
    session_duration: "24h",
    self_hosted_domains: [DOMAIN],
    uid: "should-be-dropped",
  }, { args: ["--arg", "w", `*.${DOMAIN}`], raw: false });

  assert.deepEqual(JSON.parse(body), {
    name: "acme",
    domain: DOMAIN,
    type: "self_hosted",
    session_duration: "24h",
    self_hosted_domains: [DOMAIN, `*.${DOMAIN}`],
  });
});

test("the back-fill PUT body drops null top-level fields rather than sending them", () => {
  const [body] = jq("wildcard-put-body.jq", {
    name: "acme",
    domain: DOMAIN,
    type: "self_hosted",
    session_duration: null,
    self_hosted_domains: [DOMAIN],
  }, { args: ["--arg", "w", `*.${DOMAIN}`], raw: false });

  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ["domain", "name", "self_hosted_domains", "type"]);
});

test("KNOWN GAP: on a destinations-only app the PUT body drops destinations and can carry a null domain", () => {
  // Pinned deliberately. The back-fill is best-effort and non-fatal (the apex
  // gate is already up and a failed PUT only warns), but this is the shape that
  // would rewrite a destinations-based app. If the back-fill is ever made
  // fatal, or destination-based apps become the norm, fix this first.
  const [body] = jq("wildcard-put-body.jq", {
    name: "acme",
    type: "self_hosted",
    session_duration: "24h",
    destinations: [{ type: "public", uri: DOMAIN }, { type: "public", uri: "second.example" }],
  }, { args: ["--arg", "w", `*.${DOMAIN}`], raw: false });

  const parsed = JSON.parse(body);
  assert.ok(!("destinations" in parsed), "documents that destinations are not carried over");
  assert.deepEqual(parsed.self_hosted_domains, [null, `*.${DOMAIN}`]);
});

// ── Drift guards ──────────────────────────────────────────────────────

/** The expression from a fixture, with its `#` header stripped. */
function expression(file) {
  return readFileSync(path.join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.trimStart().startsWith("#"))
    .join("\n")
    .trim();
}

// Three call sites since #67: the post-deploy gate check now resolves the app
// over the API when the live probe is inconclusive (a first deploy answers 522
// for minutes before the edge serves it), so "is the gate configured?" no longer
// depends on edge propagation. It reuses this exact matcher — the guard below is
// what forces that, and it caught the addition when it was written by hand.
const CALL_SITES = 3;

test("DRIFT GUARD: the tested matcher is character-for-character the one in deploy-pages.yml, at every call site", () => {
  const expr = expression("find-access-app.jq");
  const occurrences = WORKFLOW.split(expr).length - 1;
  assert.equal(
    occurrences,
    CALL_SITES,
    "the matcher must appear verbatim at the private-mode resolver, the public-mode gate remover, and the " +
      "post-deploy gate verification; if you changed it in the workflow, update tests/fixtures/find-access-app.jq to match",
  );
});

test("DRIFT GUARD: the tested wildcard detector is the one in deploy-pages.yml", () => {
  assert.equal(WORKFLOW.split(expression("has-wildcard.jq")).length - 1, 1);
});

test("DRIFT GUARD: the tested PUT-body builder is the one in deploy-pages.yml", () => {
  assert.equal(WORKFLOW.split(expression("wildcard-put-body.jq")).length - 1, 1);
});

test("DRIFT GUARD: no OTHER jq expression in the workflow selects an Access app by domain", () => {
  // Catches a call site added without the shared shape — the way the original
  // two drifted apart in the first place. Counting selector LINES separately
  // from verbatim matches above is what makes that possible: a near-copy would
  // land here (n+1 selectors) while failing the verbatim count, naming the
  // offending line instead of just reporting a number that didn't match.
  const selectors = WORKFLOW.split("\n").filter(
    (l) => l.includes("self_hosted_domains") && l.includes("index($d)"),
  );
  assert.equal(selectors.length, CALL_SITES, `unexpected app selectors:\n${selectors.join("\n")}`);
});
