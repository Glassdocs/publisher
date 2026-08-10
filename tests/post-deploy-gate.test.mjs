// ──────────────────────────────────────────────────────────────────────
// The post-deploy gate check — the step that decides whether a freshly
// deployed KB is safe to leave live, and the only place in this workflow that
// DESTROYS customer infrastructure.
//
// It shipped broken in three ways at once (glassdocs#67), and each defect was
// invisible to every test that existed:
//
//   • a 55s window failed correctly-gated FIRST deploys, because a Pages
//     project created seconds earlier answers 522 at the edge for minutes;
//   • the "fail closed" rollback deleted the ACTIVE production deployment,
//     which Cloudflare refuses (8000034) even with ?force=true — so on a first
//     deploy, the only shape that reached it, it could never once have worked;
//   • "nothing was served" (522/000) and "content was served to the world"
//     (200) took the same destructive path, though they are opposite facts.
//
// So the assertions below are mostly about EVIDENCE, not messages: which
// observation justifies which action. The two that matter most are the pair at
// the bottom — no destructive call on inconclusive evidence, and a real one on
// proof — because that is the property the old step got exactly backwards.
//
// The script under test is extracted from the workflow, never re-typed.
// ──────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, runStep, workflowStep } from "./helpers/harness.mjs";

const GATED_STEP = "Post-deploy — verify site is protected";
const PUBLIC_STEP = "Post-deploy — verify public site is live";

const DOMAIN = "kb.pages.dev";
const gated = workflowStep(GATED_STEP);
const publicStep = workflowStep(PUBLIC_STEP);

// ── scripted Cloudflare ────────────────────────────────────────────────
// Route order matters: the deployments list URL also contains
// "/pages/projects/", so the specific routes come first.

/** The site answers `status` to every unauthenticated probe. */
const site = (status) => ({ urlIncludes: `https://${DOMAIN}`, status, bodyText: "" });

const deployments = (ids) => ({
  urlIncludes: "/deployments?per_page",
  body: {
    success: true,
    result: ids.map((id) => ({ id, environment: "production", latest_stage: { status: "success" } })),
  },
});

const rollbackOk = { method: "POST", urlIncludes: "/rollback", body: { success: true } };
const deleteProjectOk = { method: "DELETE", urlIncludes: "/pages/projects/", body: { success: true } };

const accessApps = (apps) => ({
  urlIncludes: "/access/apps?page=",
  body: { success: true, result: apps, result_info: { total_pages: 1 } },
});
const accessAppsFail = {
  urlIncludes: "/access/apps?page=",
  status: 403,
  body: { success: false, errors: [{ message: "Authentication error" }] },
};
const policies = (n) => ({
  urlIncludes: "/policies",
  body: { success: true, result: Array.from({ length: n }, (_, i) => ({ id: `p${i}` })) },
});

const APP = { id: "app-123", domain: DOMAIN, self_hosted_domains: [DOMAIN] };

function run(routes, env = {}, script = gated) {
  const sb = sandbox(routes);
  const res = runStep(sb, script, {
    DOMAIN,
    PROJECT_NAME: "kb",
    FIRST_DEPLOY: "false",
    CLOUDFLARE_API_TOKEN: "tok",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    ...env,
  });
  return { res, sb };
}

/** Calls that change state on the customer's account. */
const destructive = (sb) =>
  sb.requests().filter((r) => r.method === "DELETE" || r.url.includes("/rollback"));

// ── the three verdicts ─────────────────────────────────────────────────

test("a redirect to the Access login is proof of the gate — pass", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { res, sb } = run([site(status)]);
    assert.equal(res.status, 0, `HTTP ${status} must pass:\n${res.out}`);
    assert.match(res.out, /Gate confirmed/);
    assert.deepEqual(destructive(sb), [], `HTTP ${status} must not destroy anything`);
    sb.cleanup();
  }
});

test("content served to an anonymous request is proof of EXPOSURE — roll production back", () => {
  const { res, sb } = run([site(200), deployments(["active-bad", "older-good"]), rollbackOk]);
  assert.equal(res.status, 1);
  assert.match(res.out, /SERVED CONTENT/);
  // Rolling back to the ACTIVE deployment would be a no-op that reads as success.
  const rb = sb.requests().find((r) => r.url.includes("/rollback"));
  assert.ok(rb, `expected a rollback call, got:\n${sb.calls().join("\n")}`);
  assert.match(rb.url, /older-good\/rollback$/, "must roll back to the PREVIOUS good build");
  assert.doesNotMatch(rb.url, /active-bad/);
  sb.cleanup();
});

test("exposed with nothing to roll back to: the project THIS RUN created is deleted", () => {
  // The case the old step could never handle. Cloudflare refuses to delete the
  // active production deployment (8000034), so with nothing to roll back to,
  // removing the project this run created is the only way to stop serving.
  const { res, sb } = run([site(200), deployments(["only-one"]), deleteProjectOk], {
    PROJECT_CREATED_HERE: "true",
  });
  assert.equal(res.status, 1);
  assert.match(res.out, /Deleted Pages project/);
  const del = sb.requests().find((r) => r.method === "DELETE");
  assert.ok(del, "expected the project delete");
  assert.match(del.path, /\/pages\/projects\/kb$/, "deletes the PROJECT, not a deployment");
  assert.equal(
    sb.requests().some((r) => r.url.includes("/deployments/") && r.method === "DELETE"),
    false,
    "must not retry the deployment delete Cloudflare always refuses",
  );
  sb.cleanup();
});

test("exposed, nothing to roll back to, project NOT created here: says so instead of deleting", () => {
  // Deleting a project this run did NOT create would destroy a customer's site
  // over a check failure. Refuse, and say the site is still live.
  const { res, sb } = run([site(200), deployments(["only-one"])], { PROJECT_CREATED_HERE: "false" });
  assert.equal(res.status, 1);
  assert.match(res.out, /STILL LIVE/);
  assert.deepEqual(destructive(sb), [], "a pre-existing project is never deleted");
  sb.cleanup();
});

test("the DELETE is gated on who created the project, NOT on the first-deploy heuristic", () => {
  // FIRST_DEPLOY comes from access_ready=='false', which is really "the
  // pre-deploy Access-app creation failed with 12130 or a 500" — a transient
  // Cloudflare error sets it on a project that has existed for months. Gating a
  // project delete on that would turn a 500 plus a bad probe into an outage, so
  // the two flags must not be interchangeable.
  const { res, sb } = run([site(200), deployments(["only-one"])], {
    FIRST_DEPLOY: "true", // the heuristic says "brand new"...
    PROJECT_CREATED_HERE: "false", // ...but this run demonstrably did not create it
  });
  assert.equal(res.status, 1);
  assert.deepEqual(destructive(sb), [], "FIRST_DEPLOY alone must never authorise a delete");
  assert.match(res.out, /did NOT create/);
  sb.cleanup();
});

// ── inconclusive: the first-deploy race that started this ──────────────

test("522 with the Access app configured is PROPAGATION, not exposure — pass with a warning", () => {
  // The exact production failure: TheRocketLab/knowbeforeyougo answered 522 for
  // the whole window while gated by an Access app that already existed.
  const { res, sb } = run([site(522), accessApps([APP]), policies(1)], { FIRST_DEPLOY: "true" });
  assert.equal(res.status, 0, `must not fail a gated first deploy:\n${res.out}`);
  assert.match(res.out, /the gate IS configured/);
  assert.match(res.out, /::warning::/, "passes, but never silently");
  assert.deepEqual(destructive(sb), []);
  sb.cleanup();
});

test("the API verdict does not depend on the edge: every unreachable status behaves alike", () => {
  for (const status of [522, 0, 500, 404, 403]) {
    const { res, sb } = run([site(status), accessApps([APP]), policies(2)]);
    assert.equal(res.status, 0, `HTTP ${status}:\n${res.out}`);
    assert.deepEqual(destructive(sb), []);
    sb.cleanup();
  }
});

test("an Access app with ZERO policies gates no one — fail, but destroy nothing", () => {
  const { res, sb } = run([site(522), accessApps([APP]), policies(0)]);
  assert.equal(res.status, 1);
  assert.match(res.out, /NO policies/);
  assert.deepEqual(destructive(sb), [], "nothing is being served, so there is nothing to take down");
  sb.cleanup();
});

test("no Access app at all — fail, and warn the site will be public once it is reachable", () => {
  const { res, sb } = run([site(522), accessApps([])]);
  assert.equal(res.status, 1);
  assert.match(res.out, /No Cloudflare Access app covers/);
  assert.match(res.out, /will be PUBLIC once it is/);
  assert.deepEqual(destructive(sb), []);
  sb.cleanup();
});

test("'couldn't read the Access config' is never reported as 'no gate exists'", () => {
  // Different causes, different fixes: one is a token scope, the other is a
  // missing app. Cloudflare returns 200 + an empty list to a token lacking the
  // Access permission (glassdocs#68), so this distinction is load-bearing.
  const { res, sb } = run([site(522), accessAppsFail]);
  assert.equal(res.status, 1);
  assert.match(res.out, /Couldn't read the Access configuration/);
  assert.doesNotMatch(res.out, /No Cloudflare Access app covers/);
  assert.deepEqual(destructive(sb), []);
  sb.cleanup();
});

// ── the property the old step got backwards ────────────────────────────

test("PROPERTY: no unreachable status, under any Access state, destroys anything", () => {
  const states = [
    ["app + policy", [accessApps([APP]), policies(1)]],
    ["app, no policy", [accessApps([APP]), policies(0)]],
    ["no app", [accessApps([])]],
    ["can't list", [accessAppsFail]],
  ];
  for (const status of [522, 0, 500, 404]) {
    for (const [label, routes] of states) {
      for (const first of ["true", "false"]) {
        const { sb } = run([site(status), deployments(["a", "b"]), ...routes], {
          FIRST_DEPLOY: first,
          PROJECT_CREATED_HERE: first,
        });
        assert.deepEqual(
          destructive(sb).map((r) => `${r.method} ${r.path}`),
          [],
          `HTTP ${status} / ${label} / first=${first} must not destroy anything`,
        );
        sb.cleanup();
      }
    }
  }
});

test("PROPERTY: proven exposure always results in an action, never a bare warning", () => {
  for (const [label, routes, env] of [
    ["previous build exists", [deployments(["bad", "good"]), rollbackOk], {}],
    ["created here, no previous build", [deployments(["only"]), deleteProjectOk], { PROJECT_CREATED_HERE: "true" }],
  ]) {
    const { res, sb } = run([site(200), ...routes], env);
    assert.equal(res.status, 1, label);
    assert.ok(destructive(sb).length > 0, `${label}: exposure must trigger a real action`);
    sb.cleanup();
  }
});

// ── the retry loop actually retries ────────────────────────────────────

test("the probe polls until the deadline rather than judging on one observation", () => {
  // A 200 can be Access-policy propagation lag, so a single sample must not
  // condemn a deploy — the verdict is the FINAL observation.
  const sb = sandbox([site(522), accessApps([APP]), policies(1)]);
  const res = runStep(sb, gated, {
    DOMAIN,
    PROJECT_NAME: "kb",
    FIRST_DEPLOY: "false",
    CLOUDFLARE_API_TOKEN: "tok",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    VERIFY_BUDGET_SECONDS: "2",
    VERIFY_POLL_SECONDS: "0",
  });
  const probes = sb.requests().filter((r) => r.url.startsWith(`https://${DOMAIN}`));
  assert.ok(probes.length > 1, `expected repeated probes, got ${probes.length}:\n${res.out}`);
  sb.cleanup();
});

test("a first deploy ships a longer window than a redeploy", () => {
  // The defect itself: a fixed ~55s window for both, which no first deploy
  // could win. Asserted on the shipped defaults rather than by running the
  // step — exercising them means really sleeping for five minutes, and the
  // deadline loop they feed is already covered by the test above.
  const [redeploy, firstDeploy] = [...gated.matchAll(/VERIFY_BUDGET_SECONDS:-(\d+)\}/g)].map((m) => Number(m[1]));
  assert.ok(
    Number.isFinite(redeploy) && Number.isFinite(firstDeploy),
    "both budget defaults must be readable from the step",
  );
  assert.ok(
    firstDeploy > redeploy,
    `a first deploy must get longer than a redeploy (first=${firstDeploy}s, redeploy=${redeploy}s)`,
  );
  assert.ok(
    firstDeploy >= 240,
    `a first deploy needs minutes, not seconds — a real one was still 522 after 76s (got ${firstDeploy}s)`,
  );
});

// ── public mode: same race, but it must never destroy ──────────────────

test("public mode: live site passes; unreachable or still-gated fails without destroying", () => {
  const project = { urlIncludes: "/pages/projects/kb", body: { success: true, result: { subdomain: DOMAIN } } };
  const cases = [
    [200, 0, /Public site is live/],
    [302, 1, /still redirects/],
    [522, 1, /not serving content/],
  ];
  for (const [status, code, expected] of cases) {
    const sb = sandbox([site(status), project]);
    const res = runStep(sb, publicStep, {
      PROJECT_NAME: "kb",
      FIRST_DEPLOY: "true",
      CLOUDFLARE_API_TOKEN: "tok",
      CLOUDFLARE_ACCOUNT_ID: "acct",
    });
    assert.equal(res.status, code, `HTTP ${status}:\n${res.out}`);
    assert.match(res.out, expected);
    // A still-gated public site is the SAFE direction of failure — a public KB
    // is never worth destroying a deployment over.
    assert.deepEqual(destructive(sb), [], `HTTP ${status} must not destroy anything`);
    sb.cleanup();
  }
});
