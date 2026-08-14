// ──────────────────────────────────────────────────────────────────────
// The Pages-project subdomain lookup — the value every Access decision in
// deploy-pages.yml is keyed to.
//
// Four steps ask Cloudflare "what domain is this project actually served at?"
// and the answer becomes $DOMAIN: the domain the Access app is created for, the
// domain the pre-flight gate check probes, the domain the post-deploy verify
// probes, and therefore the domain whose 200 triggers a ROLLBACK or a project
// DELETE.
//
// All four used to do `curl -s` with no --fail and no status read, then
// `jq -r '.result.subdomain // empty'`, then treat empty as "the project does
// not exist yet" and guess `<name>.pages.dev`. `.result` is null for EVERY
// non-2xx Cloudflare answer — 401, 403, 429, 5xx — because `curl -s` exits 0
// and prints {"success":false,...}. So a token that lost scope mid-deploy made
// the workflow announce a project absent that plainly exists, skip the policy
// sync and the pre-flight check, and publish (glassdocs#239).
//
// On a project carrying a global pages.dev collision suffix the guess is worse
// than wrong: `<name>.pages.dev` belongs BY DEFINITION to a different Cloudflare
// account, and a stranger's 200 is what this workflow defines as PROVEN EXPOSED.
//
// This is the same conflation #171 fixed for the audio Release lookup. The
// assertions below are about which observation licenses which action: only a
// real 404 may license a guess.
//
// The scripts under test are extracted from the workflow, never re-typed.
// ──────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sandbox, runStep, workflowStep } from "./helpers/harness.mjs";

const GATED_STEP = "Ensure Cloudflare Access app";
const PUBLIC_STEP = "Public mode — resolve domain, drop any Access gate";
const FIRSTDEPLOY_STEP = "Create Access app (first deploy)";
const PUBLIC_VERIFY_STEP = "Post-deploy — verify public site is live";

const gated = workflowStep(GATED_STEP);
const publicMode = workflowStep(PUBLIC_STEP);
const firstDeploy = workflowStep(FIRSTDEPLOY_STEP);
const publicVerify = workflowStep(PUBLIC_VERIFY_STEP);

const PROJECT = "kb";
const NAME_DOMAIN = "kb.pages.dev";
const REAL_DOMAIN = "kb-xyz.pages.dev"; // the collision-suffixed subdomain

// ── what Cloudflare actually answers ───────────────────────────────────
// Bodies verified against Cloudflare's documented v4 error envelope: a 403 from
// a token without the scope is `9109 Unauthorized to access requested resource`;
// a project that is genuinely absent is `8000007 Project not found` with a null
// result. Both carry HTTP-level status AND `success:false` — which is exactly
// why reading only the body cannot tell them apart.
const PROJECT_URL = `/pages/projects/${PROJECT}`;

const projectOk = (subdomain) => ({
  method: "GET",
  urlIncludes: PROJECT_URL,
  status: 200,
  body: { success: true, errors: [], messages: [], result: { name: PROJECT, subdomain } },
});

const project404 = {
  method: "GET",
  urlIncludes: PROJECT_URL,
  status: 404,
  body: { success: false, errors: [{ code: 8000007, message: "Project not found" }], result: null },
};

const project403 = {
  method: "GET",
  urlIncludes: PROJECT_URL,
  status: 403,
  body: {
    success: false,
    errors: [{ code: 9109, message: "Unauthorized to access requested resource" }],
    result: null,
  },
};

const project500 = {
  method: "GET",
  urlIncludes: PROJECT_URL,
  status: 500,
  body: { success: false, errors: [{ code: 10000, message: "internal error" }], result: null },
};

/**
 * curl itself fails — the timeout case.
 *
 * Measured, not assumed: real curl still expands `-w '%{http_code}'`, writing
 * literal `000`, and exits 28. The `CODE=$(curl …) || CODE=''` idiom then
 * overwrites that with the empty string, because a command substitution's exit
 * status IS the assignment's. So the code under test must handle an empty CODE,
 * and the mock must reproduce both halves — the `000` on stdout and the
 * non-zero exit — or the test proves nothing about the real contract.
 */
const projectCurlFails = {
  method: "GET",
  urlIncludes: PROJECT_URL,
  status: "000",
  bodyText: "",
  exit: 28,
  stderr: "curl: (28) Operation timed out after 30001 milliseconds\n",
};

/** A 200 whose body carries no subdomain — malformed, NOT an absent project. */
const projectOkNoSubdomain = {
  method: "GET",
  urlIncludes: PROJECT_URL,
  status: 200,
  body: { success: true, errors: [], result: { name: PROJECT } },
};

const accessApps = (apps) => ({
  urlIncludes: "/access/apps?page=",
  status: 200,
  body: { success: true, result: apps, result_info: { total_pages: 1 } },
});

const app = (domain) => ({
  id: "app-123",
  name: PROJECT,
  domain,
  type: "self_hosted",
  session_duration: "24h",
  self_hosted_domains: [domain, `*.${domain}`],
});

const createOk = {
  method: "POST",
  urlIncludes: "/access/apps",
  status: 200,
  body: { success: true, result: { id: "app-new" } },
};

/** Access refuses the domain: 12130 "domain does not belong to zone". */
const create12130 = {
  method: "POST",
  urlIncludes: "/access/apps",
  status: 403,
  body: {
    success: false,
    errors: [{ code: 12130, message: "access.api.error.domain_does_not_belong_to_zone: domain does not belong to zone" }],
  },
};

const create5xx = {
  method: "POST",
  urlIncludes: "/access/apps",
  status: 500,
  body: { success: false, errors: [{ code: 10000, message: "internal_server_error" }] },
};

const site = (domain, status) => ({ urlIncludes: `https://${domain}`, status, bodyText: "" });

// ── running a step ─────────────────────────────────────────────────────

function run(script, routes, env = {}) {
  const sb = sandbox(routes);
  const outFile = path.join(sb.dir, "github-output");
  writeFileSync(outFile, "");
  const res = runStep(sb, script, {
    PROJECT_NAME: PROJECT,
    CLOUDFLARE_API_TOKEN: "tok-test",
    CLOUDFLARE_ACCOUNT_ID: "acct-test",
    GITHUB_OUTPUT: outFile,
    ...env,
  });
  return {
    res,
    sb,
    /** The step's `$GITHUB_OUTPUT` as a {key: value} map. */
    outputs() {
      const map = {};
      for (const line of readFileSync(outFile, "utf8").split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) map[line.slice(0, i)] = line.slice(i + 1);
      }
      return map;
    },
  };
}

/** Every URL the step probed or mutated, for "did it act on the guess?" checks. */
const urls = (sb) => sb.requests().map((r) => r.url);

// ── 1. a FAILED lookup is not an absent project ────────────────────────

test("HTTP 403 on the project lookup fails the step — it is not 'project not created yet'", () => {
  // The bug, in one assertion. Before #239 this exited 0, printed "Project not
  // created yet", guessed kb.pages.dev, and carried on — with $DOMAIN, and
  // therefore the rollback probe, pointed at a domain this account may not own.
  const { res, sb, outputs } = run(gated, [project403, accessApps([app(NAME_DOMAIN)])]);

  assert.notEqual(res.status, 0, `a 403 must fail the step, got exit 0:\n${res.out}`);
  assert.match(res.out, /::error::/);
  assert.match(res.out, /403/, "the error must name the HTTP status");
  assert.match(res.out, /Unauthorized to access requested resource/, "…and Cloudflare's own message");
  assert.doesNotMatch(
    res.out,
    /Project not created yet/,
    "a lookup that FAILED must never be reported as a project that does not exist",
  );
  // Never the token, at any status (the preflight prints only its length).
  assert.doesNotMatch(res.out, /tok-test/, "the API token must never be logged");
  // And it must stop BEFORE anything acts on a guessed domain.
  assert.equal(
    outputs().domain,
    undefined,
    `no domain may be exported from a failed lookup, got ${JSON.stringify(outputs())}`,
  );
  assert.deepEqual(
    urls(sb).filter((u) => u.includes("/access/")),
    [],
    "the Access API must not be touched on a guessed domain",
  );
  sb.cleanup();
});

test("HTTP 500 and a curl timeout fail the same way — both are 'we do not know'", () => {
  for (const [label, route] of [["500", project500], ["curl failure", projectCurlFails]]) {
    const { res, sb } = run(gated, [route, accessApps([app(NAME_DOMAIN)])]);
    assert.notEqual(res.status, 0, `${label} must fail the step:\n${res.out}`);
    assert.match(res.out, /::error::/, label);
    assert.doesNotMatch(res.out, /Project not created yet/, label);
    sb.cleanup();
  }
});

test("the first-deploy re-read diagnoses a failure instead of silently keeping the guess", () => {
  // Measured correction to the shape of the old bug at this site: it piped curl
  // straight into jq, so an HTTP 403 was COMPLETELY silent (jq exits 0 on an
  // error body, $REAL came back empty, and `[ -n "$REAL" ] && DOMAIN=…` is
  // exempt from errexit) — the guessed domain sailed through to `real_domain`,
  // which is what the rollback and the delete act on.
  const { res, sb, outputs } = run(firstDeploy, [project403, createOk], { DOMAIN: NAME_DOMAIN });
  assert.notEqual(res.status, 0, `a 403 must fail the step:\n${res.out}`);
  assert.match(res.out, /::error::/);
  assert.match(res.out, /403/);
  assert.equal(outputs().real_domain, undefined, "no guessed domain may reach real_domain");
  assert.deepEqual(
    urls(sb).filter((u) => u.includes("/access/apps")),
    [],
    "no Access app may be created for a domain we could not confirm",
  );
  sb.cleanup();
});

test("a curl failure is caught without relying on `set -e` — and now says why", () => {
  // A transport failure DID abort this step before, via `pipefail` — but with
  // nothing except curl's own stderr line: no ::error::, no diagnosis, and on
  // the other two sites (which assign before piping) no abort at all. The
  // resolver checks curl's status itself so the outcome is the same in all four
  // steps regardless of their shell options.
  const { res, sb } = run(firstDeploy, [projectCurlFails], { DOMAIN: NAME_DOMAIN });
  assert.notEqual(res.status, 0, `a curl failure must fail the step:\n${res.out}`);
  assert.match(res.out, /::error::/);
  assert.match(res.out, /curl failed or timed out/, "an empty status must be named as such");
  assert.deepEqual(
    urls(sb).filter((u) => u.includes("/access/apps")),
    [],
    "no Access app may be created for a domain we could not confirm",
  );
  sb.cleanup();
});

test("a 200 with no .result.subdomain is malformed, not absent — fail, do not guess", () => {
  const { res, sb } = run(gated, [projectOkNoSubdomain, accessApps([app(NAME_DOMAIN)])]);
  assert.notEqual(res.status, 0, `a 200 without a subdomain must fail:\n${res.out}`);
  assert.match(res.out, /::error::/);
  assert.match(res.out, /200/, "the error must name the status it did get");
  assert.doesNotMatch(res.out, /Project not created yet/);
  sb.cleanup();
});

// ── 2. a real 404 is the ONLY case that may guess ───────────────────────

test("HTTP 404 is a genuine first deploy — name-based domain, today's message, exit 0", () => {
  // Unchanged behaviour. This is the one branch where guessing is correct:
  // Cloudflare has told us the project is not there.
  const { res, sb, outputs } = run(gated, [project404, accessApps([]), createOk]);
  assert.equal(res.status, 0, `a 404 must not fail the step:\n${res.out}`);
  assert.match(res.out, /Project not created yet/);
  assert.match(res.out, new RegExp(`using name-based domain ${NAME_DOMAIN.replace(/\./g, "\\.")}`));
  assert.equal(outputs().domain, NAME_DOMAIN);
  sb.cleanup();
});

test("HTTP 404 in public mode also keeps the name-based fallback", () => {
  const { res, sb, outputs } = run(publicMode, [project404, accessApps([])]);
  assert.equal(res.status, 0, `a 404 must not fail public mode:\n${res.out}`);
  assert.match(res.out, /Project not created yet/);
  assert.equal(outputs().domain, NAME_DOMAIN);
  sb.cleanup();
});

// ── 3. a 200 is believed, suffix and all ────────────────────────────────

test("a collision-suffixed subdomain still warns and is still what gets protected", () => {
  const { res, sb, outputs } = run(gated, [projectOk(REAL_DOMAIN), accessApps([app(REAL_DOMAIN)])]);
  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /::warning::pages\.dev name collision/);
  assert.match(res.out, new RegExp(`real domain is ${REAL_DOMAIN.replace(/\./g, "\\.")}`));
  assert.equal(outputs().domain, REAL_DOMAIN, "the REAL domain must be exported, not the name-based guess");
  assert.equal(outputs().access_ready, "true");
  sb.cleanup();
});

test("the first-deploy re-read believes the real subdomain and exports it before creating", () => {
  const { res, sb, outputs } = run(firstDeploy, [projectOk(REAL_DOMAIN), createOk], {
    DOMAIN: NAME_DOMAIN, // the earlier step's guess, which this step must correct
  });
  assert.equal(res.status, 0, res.out);
  assert.equal(outputs().real_domain, REAL_DOMAIN);
  const created = sb.requests().find((r) => r.method === "POST" && r.url.includes("/access/apps"));
  assert.ok(created, `expected an Access app create, got:\n${sb.calls().join("\n")}`);
  assert.match(created.body, new RegExp(REAL_DOMAIN.replace(/\./g, "\\.")));
  sb.cleanup();
});

// ── 4. 12130 is not a synonym for "the project isn't there" ─────────────

test("12130 on a project that EXISTS is a real collision — fail, naming the domain", () => {
  // Before #239 this printed "Pages project does not exist yet" about a project
  // the lookup had just returned a subdomain for, then set access_ready=false —
  // which SKIPS both the policy sync and the pre-flight gate check, and lets the
  // deploy publish ungated.
  const { res, sb, outputs } = run(gated, [projectOk(REAL_DOMAIN), accessApps([]), create12130]);
  assert.notEqual(res.status, 0, `12130 on an existing project must fail:\n${res.out}`);
  assert.match(res.out, /::error::/);
  assert.match(res.out, new RegExp(REAL_DOMAIN.replace(/\./g, "\\.")), "the error must name the domain");
  assert.match(res.out, /acct-test/, "…and the account it was asked of");
  assert.doesNotMatch(res.out, /Pages project does not exist yet/);
  assert.notEqual(outputs().access_ready, "false", "must not defer to the first-deploy path");
  sb.cleanup();
});

test("12130 on a TRUE first deploy is still the expected deferral, not a failure", () => {
  // Cloudflare cannot bind an Access app to a pages.dev domain that no project
  // serves yet, so on a 404 this is the normal path: record it and create the
  // app after the deploy. Making 12130 unconditionally fatal would break every
  // new KB.
  const { res, sb, outputs } = run(gated, [project404, accessApps([]), create12130]);
  assert.equal(res.status, 0, `12130 after a 404 must not fail the step:\n${res.out}`);
  assert.match(res.out, /::warning::/);
  assert.equal(outputs().access_ready, "false");
  sb.cleanup();
});

test("internal_server_error stays a transient warning with access_ready=false", () => {
  const { res, sb, outputs } = run(gated, [projectOk(REAL_DOMAIN), accessApps([]), create5xx]);
  assert.equal(res.status, 0, `a transient 5xx must not fail the step:\n${res.out}`);
  assert.match(res.out, /::warning::/);
  assert.equal(outputs().access_ready, "false");
  sb.cleanup();
});

// ── 5. the public post-deploy verify probes a KNOWN domain ──────────────

test("the public verify refuses to probe a guessed domain when the lookup fails", () => {
  // This step's $DOMAIN decides which site a 200 is read off. On a failed lookup
  // it used to fall back to kb.pages.dev — which, on a collision, is somebody
  // else's site — and report it as ours, live.
  const { res, sb } = run(publicVerify, [project403, site(NAME_DOMAIN, 200), site(REAL_DOMAIN, 200)], {
    FIRST_DEPLOY: "false",
  });
  assert.notEqual(res.status, 0, `a 403 must fail the verify:\n${res.out}`);
  assert.match(res.out, /::error::/);
  assert.match(res.out, /403/);
  assert.deepEqual(
    urls(sb).filter((u) => u.startsWith("https://kb")),
    [],
    "no site may be probed before the domain is known",
  );
  sb.cleanup();
});

test("the public verify uses the real subdomain, and a 404 still falls back", () => {
  const live = run(publicVerify, [projectOk(REAL_DOMAIN), site(REAL_DOMAIN, 200)], { FIRST_DEPLOY: "false" });
  assert.equal(live.res.status, 0, live.res.out);
  assert.match(live.res.out, new RegExp(`https://${REAL_DOMAIN.replace(/\./g, "\\.")}`));
  live.sb.cleanup();

  const fresh = run(publicVerify, [project404, site(NAME_DOMAIN, 200)], { FIRST_DEPLOY: "false" });
  assert.equal(fresh.res.status, 0, fresh.res.out);
  assert.match(fresh.res.out, new RegExp(`https://${NAME_DOMAIN.replace(/\./g, "\\.")}`));
  fresh.sb.cleanup();
});

// ── 6. drift guards ─────────────────────────────────────────────────────

const WORKFLOW_TEXT = readFileSync(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8");

/** Every `resolve_pages_subdomain() { … }` body, comments and indentation stripped. */
function resolverBodies(text) {
  const out = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/resolve_pages_subdomain\(\)\s*\{/.test(lines[i])) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === "}" && lines[j].length - lines[j].trimStart().length === indent) break;
      if (t === "" || t.startsWith("#")) continue;
      body.push(t);
    }
    out.push(body.join("\n"));
  }
  return out;
}

test("all four Pages-project lookups go through the identical resolver", () => {
  // The resolver is duplicated because the steps of a reusable workflow share no
  // shell. Duplication that can drift is worse than none: a fifth site, or one
  // copy quietly reverted to `curl -s | jq`, restores exactly the bug #239 fixed
  // at whichever of them happens to be nearest the delete.
  const bodies = resolverBodies(WORKFLOW_TEXT);
  assert.equal(bodies.length, 4, `expected the resolver at all four lookup sites, found ${bodies.length}`);
  for (const [i, body] of bodies.entries()) {
    assert.equal(body, bodies[0], `resolver copy ${i + 1} has drifted from the canonical one`);
    assert.match(body, /--max-time 30/, "a lookup with no timeout hangs the job to the runner limit");
    assert.match(body, /%\{http_code\}/, "the HTTP status must be read separately from the body");
    assert.doesNotMatch(body, /--fail/, "--fail re-collapses 401 and 404 and discards the message");
  }
});

test("nothing reads .result.subdomain outside the resolver, and nothing pipes the lookup into jq", () => {
  const reads = WORKFLOW_TEXT.match(/jq -r '\.result\.subdomain \/\/ empty'/g) ?? [];
  assert.equal(reads.length, 4, `every .result.subdomain read must be a resolver's, found ${reads.length}`);
  assert.doesNotMatch(
    WORKFLOW_TEXT,
    /pages\/projects\/\$\{PROJECT_NAME\}"?\s*\\?\n[^\n]*\|\s*jq/,
    "a Pages lookup piped straight into jq hides curl's exit status",
  );
  // The token's VALUE never reaches a log line. Naming the secret in prose is
  // fine and necessary ("set CLOUDFLARE_API_TOKEN"); so are the three forms that
  // cannot print it — `${#TOKEN}` (length), `${TOKEN:+…}` and `${TOKEN:-…}`
  // (presence), which is exactly what the credentials preflight deliberately
  // uses. Anything else that expands it inside an echo would put a live
  // Cloudflare token in a public Actions log.
  const SAFE = /\$\{#CLOUDFLARE_API_TOKEN\}|\$\{CLOUDFLARE_API_TOKEN:[+-][^}]*\}/g;
  for (const line of WORKFLOW_TEXT.split("\n")) {
    if (!/^\s*echo /.test(line)) continue;
    assert.doesNotMatch(
      line.replace(SAFE, ""),
      /\$\{?CLOUDFLARE_API_TOKEN/,
      `the API token's value must never be echoed: ${line.trim()}`,
    );
  }
});
