// ──────────────────────────────────────────────────────────────────────
// sync-access-policies.sh — the script that decides who can reach a customer
// KB. Every invariant below corresponds to a bug that has actually shipped or
// to the lockout scenario the create-first ordering exists to prevent.
//
// Assertions are on BOTH the outcome and the recorded call sequence: the
// lockout bug was an ordering bug, and an outcome-only test passes on it.
// ──────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";
import { sandbox, runSync, policyList, policy, POLICIES_PATH, APP_ID } from "./helpers/harness.mjs";

const OLD_A = policy("old-a", "Allow staff + clients", 1);
const OLD_B = policy("old-b", "Office network bypass", 2);

/** Routes for a healthy API: one page of policies, creates and deletes succeed. */
function healthyRoutes(existing = [OLD_A, OLD_B]) {
  return [
    { method: "GET", urlIncludes: "/policies?page=1", body: policyList(existing) },
    { method: "POST", urlIncludes: "/policies", body: { success: true, errors: [], result: { id: "new-1" } } },
    { method: "DELETE", urlIncludes: "/policies/", body: { success: true, errors: [], result: null } },
  ];
}

const CF_ERROR = { success: false, errors: [{ code: 1005, message: "Access application not found" }], result: null };

function posts(sb) {
  return sb.requests().filter((r) => r.method === "POST");
}
function deletes(sb) {
  return sb.requests().filter((r) => r.method === "DELETE");
}
function bodyOf(req) {
  return JSON.parse(req.body);
}

// ── Harness self-check ────────────────────────────────────────────────

test("HARNESS: the script's HTTP calls reach the mock, so 'zero calls' assertions mean something", (t) => {
  // Without this, a mock that fell off PATH would make every
  // "no Cloudflare call was made" assertion below pass vacuously.
  const sb = sandbox(healthyRoutes());
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com" });
  assert.equal(res.status, 0, res.out);

  const reqs = sb.requests();
  assert.ok(reqs.length >= 3, "the mock must have recorded the list, create and delete calls");
  assert.ok(
    reqs.every((r) => r.headers.some((h) => h === "Authorization: Bearer tok-test")),
    "every call must carry the sandbox's fake token — a real credential would mean a real request",
  );
  assert.ok(reqs.every((r) => r.url.startsWith("https://api.cloudflare.com/")), "unexpected host");
});

// ── Lockout ordering ──────────────────────────────────────────────────

test("create-first: every new policy is POSTed before any old policy is DELETEd", (t) => {
  const sb = sandbox(healthyRoutes());
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com", OFFICE_CIDRS: "203.0.113.0/24" });
  assert.equal(res.status, 0, res.out);

  const seq = sb.methods();
  const lastPost = seq.lastIndexOf("POST");
  const firstDelete = seq.indexOf("DELETE");
  assert.ok(lastPost !== -1, `expected creates, got ${JSON.stringify(sb.calls())}`);
  assert.ok(firstDelete !== -1, `expected deletes, got ${JSON.stringify(sb.calls())}`);
  assert.ok(
    lastPost < firstDelete,
    `deletes must come after ALL creates; sequence was ${JSON.stringify(sb.calls())}`,
  );
  assert.deepEqual(seq, ["GET", "POST", "POST", "DELETE", "DELETE"]);
});

test("a failed allow-policy create leaves the existing policies intact and exits non-zero", (t) => {
  const sb = sandbox([
    { method: "GET", urlIncludes: "/policies?page=1", body: policyList([OLD_A, OLD_B]) },
    { method: "POST", urlIncludes: "/policies", body: CF_ERROR },
  ]);
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com" });

  assert.notEqual(res.status, 0, "a create failure must fail the deploy");
  assert.match(res.out, /existing policies left untouched/);
  assert.equal(deletes(sb).length, 0, `no policy may be deleted after a failed create: ${JSON.stringify(sb.calls())}`);
});

test("a failed bypass-policy create aborts before the allow policy is created and before any delete", (t) => {
  const sb = sandbox([
    { method: "GET", urlIncludes: "/policies?page=1", body: policyList([OLD_A]) },
    { method: "POST", urlIncludes: "/policies", bodyIncludes: '"bypass"', body: CF_ERROR },
    { method: "POST", urlIncludes: "/policies", body: { success: true, result: { id: "new-1" } } },
    { method: "DELETE", urlIncludes: "/policies/", body: { success: true } },
  ]);
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com", OFFICE_CIDRS: "203.0.113.0/24" });

  assert.notEqual(res.status, 0);
  assert.match(res.out, /Failed to create bypass policy/);
  assert.match(res.out, /existing policies left untouched/);
  assert.equal(posts(sb).length, 1, "must not attempt the allow policy after the bypass create failed");
  assert.equal(deletes(sb).length, 0);
});

test("a policy-list failure aborts before any mutation", (t) => {
  const sb = sandbox([{ method: "GET", urlIncludes: "/policies?page=1", body: CF_ERROR }]);
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com" });

  assert.notEqual(res.status, 0);
  assert.match(res.out, /Failed to list policies/);
  assert.deepEqual(sb.methods(), ["GET"]);
});

test("a curl transport failure while listing aborts before any mutation", (t) => {
  const sb = sandbox([
    { method: "GET", urlIncludes: "/policies?page=1", exit: 7, stderr: "curl: (7) Failed to connect" },
    { method: "POST", urlIncludes: "/policies", body: { success: true, result: { id: "new-1" } } },
    { method: "DELETE", urlIncludes: "/policies/", body: { success: true } },
  ]);
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com" });

  assert.notEqual(res.status, 0);
  assert.deepEqual(sb.methods(), ["GET"], "a dead API must not produce writes");
});

test("new policies take precedences that do not collide with the still-present old ones", (t) => {
  const sb = sandbox(healthyRoutes([policy("old-a", "Allow staff + clients", 1), policy("old-b", "Office network bypass", 2)]));
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com", OFFICE_CIDRS: "203.0.113.0/24" });
  assert.equal(res.status, 0, res.out);

  const precs = posts(sb).map((r) => bodyOf(r).precedence);
  assert.deepEqual(precs, [3, 4], "creates must skip precedences 1 and 2, which the old policies still hold");
});

// ── Up-front validation: no mutation on bad input ─────────────────────

test("an invalid email is rejected before ANY Cloudflare mutation", (t) => {
  const sb = sandbox(healthyRoutes());
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com", CLIENT_EMAILS: "ok@example.com,not-an-email" });

  assert.notEqual(res.status, 0);
  assert.match(res.out, /Invalid email in CLIENT_EMAILS/);
  assert.match(res.out, /No policies were changed/);
  assert.deepEqual(sb.calls(), [], "validation must run before the list call, so nothing is touched");
});

test("an invalid CIDR is rejected before ANY Cloudflare mutation", (t) => {
  const sb = sandbox(healthyRoutes());
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com", OFFICE_CIDRS: "203.0.113.0/24,10.0.0.0/33" });

  assert.notEqual(res.status, 0);
  assert.match(res.out, /Invalid CIDR/);
  assert.match(res.out, /No policies were changed/);
  assert.deepEqual(sb.calls(), []);
});

// ── CIDR matrix ───────────────────────────────────────────────────────

const ACCEPTED_CIDRS = [
  ["IPv4 CIDR", "203.0.113.0/24"],
  ["bare IPv4", "203.0.113.5"],
  ["IPv4 /32 host route", "203.0.113.5/32"],
  ["IPv4 /0 default route", "0.0.0.0/0"],
  ["IPv6 CIDR", "2001:db8::/32"],
  ["IPv6 /128 host route", "2001:db8::1/128"],
  ["compressed IPv6 loopback", "::1"],
  ["compressed IPv6 default route", "::/0"],
  ["IPv4-mapped IPv6", "::ffff:203.0.113.5"],
  ["full-length IPv6", "2001:0db8:0000:0000:0000:0000:0000:0001/64"],
  ["zero-padded prefix", "10.0.0.0/08"],
];

for (const [label, cidr] of ACCEPTED_CIDRS) {
  test(`OFFICE_CIDRS accepts ${label} (${cidr}) and puts it in the bypass policy verbatim`, (t) => {
    const sb = sandbox(healthyRoutes([]));
    t.after(() => sb.cleanup());

    const res = runSync(sb, { EMAIL_DOMAIN: "example.com", OFFICE_CIDRS: cidr });
    assert.equal(res.status, 0, res.out);

    const bypass = posts(sb).map(bodyOf).find((b) => b.decision === "bypass");
    assert.ok(bypass, `no bypass policy created for ${cidr}: ${res.out}`);
    assert.deepEqual(bypass.include, [{ ip: { ip: cidr } }]);
  });
}

const REJECTED_CIDRS = [
  ["IPv4 prefix above 32", "10.0.0.0/33"],
  ["IPv6 prefix above 128", "2001:db8::/129"],
  ["shell metacharacters", "evil; rm -rf /"],
  ["command substitution", "$(id)"],
  ["embedded space before the prefix", "1.2.3.0 /24"],
  ["IPv6 zone id", "fe80::1%eth0"],
  ["hostname instead of an address", "office.example.com"],
  ["IPv4 with a negative prefix", "10.0.0.0/-1"],
  ["quoted value", '"10.0.0.0/8"'],
  ["a trailing slash with no prefix", "10.0.0.0/"],
  ["a prefix too large to be an integer", "10.0.0.0/999999999999999999999"],
];

for (const [label, cidr] of REJECTED_CIDRS) {
  test(`OFFICE_CIDRS rejects ${label} (${cidr}) with zero Cloudflare calls`, (t) => {
    const sb = sandbox(healthyRoutes());
    t.after(() => sb.cleanup());

    const res = runSync(sb, { EMAIL_DOMAIN: "example.com", OFFICE_CIDRS: cidr });

    assert.notEqual(res.status, 0, `${cidr} must be rejected; output was: ${res.out}`);
    assert.deepEqual(sb.calls(), [], `${cidr} must not reach the API`);
  });
}

test("a mixed IPv4/IPv6 OFFICE_CIDRS list survives whitespace and lands in one bypass policy", (t) => {
  const sb = sandbox(healthyRoutes([]));
  t.after(() => sb.cleanup());

  const res = runSync(sb, {
    EMAIL_DOMAIN: "example.com",
    OFFICE_CIDRS: " 203.0.113.0/24 ,\t2001:db8::/32 , ::1 ,",
  });
  assert.equal(res.status, 0, res.out);

  const bypass = posts(sb).map(bodyOf).find((b) => b.decision === "bypass");
  assert.deepEqual(bypass.include, [
    { ip: { ip: "203.0.113.0/24" } },
    { ip: { ip: "2001:db8::/32" } },
    { ip: { ip: "::1" } },
  ]);
});

// ── Email trimming (the xargs regression) ─────────────────────────────

test("email trimming preserves apostrophes instead of mangling them (xargs regression)", (t) => {
  const sb = sandbox(healthyRoutes([]));
  t.after(() => sb.cleanup());

  const res = runSync(sb, { CLIENT_EMAILS: " o'brien@example.com , d'angelo@example.com " });
  assert.equal(res.status, 0, res.out);

  const allow = posts(sb).map(bodyOf).find((b) => b.decision === "allow");
  assert.deepEqual(allow.include, [
    { email: { email: "o'brien@example.com" } },
    { email: { email: "d'angelo@example.com" } },
  ]);
});

test("email trimming strips tabs and newlines without touching the address", (t) => {
  const sb = sandbox(healthyRoutes([]));
  t.after(() => sb.cleanup());

  const res = runSync(sb, { CLIENT_EMAILS: "\t a@example.com \n,\n b@example.com\t" });
  assert.equal(res.status, 0, res.out);

  const allow = posts(sb).map(bodyOf).find((b) => b.decision === "allow");
  assert.deepEqual(allow.include, [{ email: { email: "a@example.com" } }, { email: { email: "b@example.com" } }]);
});

test("a newline in CLIENT_EMAILS does not silently truncate the grant list", (t) => {
  const sb = sandbox(healthyRoutes([]));
  t.after(() => sb.cleanup());

  // A YAML block scalar or a value pasted one-per-line into the caller's
  // workflow. `read` stops at the first newline, so this used to grant only
  // the first address and drop the rest without a word.
  const res = runSync(sb, { CLIENT_EMAILS: "a@example.com,\nb@example.com\nc@example.com" });
  assert.equal(res.status, 0, res.out);

  const allow = posts(sb).map(bodyOf).find((b) => b.decision === "allow");
  assert.deepEqual(allow.include.map((i) => i.email.email), [
    "a@example.com",
    "b@example.com",
    "c@example.com",
  ]);
});

test("a LEADING newline in CLIENT_EMAILS must not produce a LOCKED deploy that deletes every policy", (t) => {
  const sb = sandbox(healthyRoutes());
  t.after(() => sb.cleanup());

  // The lockout shape: value starts with a newline, EMAIL_DOMAIN is empty, so
  // the split yielded zero grants -> allow policy skipped -> old policies
  // deleted -> everybody locked out of a working KB.
  const res = runSync(sb, { EMAIL_DOMAIN: "", CLIENT_EMAILS: "\nreal.user@example.com" });
  assert.equal(res.status, 0, res.out);

  assert.doesNotMatch(res.out, /LOCKED/, "a real grant was supplied; this KB must not deploy locked");
  const allow = posts(sb).map(bodyOf).find((b) => b.decision === "allow");
  assert.ok(allow, "the allow policy must be created before the old ones are deleted");
  assert.deepEqual(allow.include, [{ email: { email: "real.user@example.com" } }]);
});

test("OFFICE_CIDRS pasted one per line keeps every CIDR in the bypass policy", (t) => {
  const sb = sandbox(healthyRoutes([]));
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com", OFFICE_CIDRS: "203.0.113.0/24\n198.51.100.0/24\r\n2001:db8::/32" });
  assert.equal(res.status, 0, res.out);

  const bypass = posts(sb).map(bodyOf).find((b) => b.decision === "bypass");
  assert.deepEqual(bypass.include.map((i) => i.ip.ip), ["203.0.113.0/24", "198.51.100.0/24", "2001:db8::/32"]);
});

test("quotes and shell metacharacters in an email stay DATA — never code, never mangled", (t) => {
  const sb = sandbox(healthyRoutes([]));
  t.after(() => sb.cleanup());

  // Structurally e-mail-shaped, so validation admits it; the invariant is that
  // it survives trimming and jq intact and never reaches a shell as code.
  const res = runSync(sb, { CLIENT_EMAILS: ' a"b@example.com , c$(id)d@example.com ' });
  assert.equal(res.status, 0, res.out);

  const allow = posts(sb).map(bodyOf).find((b) => b.decision === "allow");
  assert.deepEqual(allow.include, [
    { email: { email: 'a"b@example.com' } },
    { email: { email: "c$(id)d@example.com" } },
  ]);
  assert.doesNotMatch(res.out, /uid=\d+/, "command substitution must never have been evaluated");
});

test("an email with interior whitespace is rejected before any mutation", (t) => {
  const sb = sandbox(healthyRoutes());
  t.after(() => sb.cleanup());

  const res = runSync(sb, { CLIENT_EMAILS: "first last@example.com" });

  assert.notEqual(res.status, 0);
  assert.match(res.out, /Invalid email in CLIENT_EMAILS/);
  assert.deepEqual(sb.calls(), []);
});

test("empty items in CLIENT_EMAILS are skipped rather than failing the deploy", (t) => {
  const sb = sandbox(healthyRoutes([]));
  t.after(() => sb.cleanup());

  const res = runSync(sb, { CLIENT_EMAILS: "a@example.com,,  , b@example.com" });
  assert.equal(res.status, 0, res.out);

  const allow = posts(sb).map(bodyOf).find((b) => b.decision === "allow");
  assert.equal(allow.include.length, 2);
});

// ── Pagination ────────────────────────────────────────────────────────

test("policies beyond page 1 are still deleted", (t) => {
  const page1 = Array.from({ length: 3 }, (_, i) => policy(`p1-${i}`, `Policy ${i}`, i + 1));
  const page2 = [policy("p2-a", "Straggler A", 51), policy("p2-b", "Straggler B", 52)];
  const sb = sandbox([
    { method: "GET", urlIncludes: "page=1", body: policyList(page1, { total_pages: 2, page: 1 }) },
    { method: "GET", urlIncludes: "page=2", body: policyList(page2, { total_pages: 2, page: 2 }) },
    { method: "POST", urlIncludes: "/policies", body: { success: true, result: { id: "new-1" } } },
    { method: "DELETE", urlIncludes: "/policies/", body: { success: true } },
  ]);
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com" });
  assert.equal(res.status, 0, res.out);

  const deleted = deletes(sb).map((r) => r.path.split("/").pop());
  assert.equal(deleted.length, 5, "all policies across both pages must be deleted");
  assert.ok(deleted.includes("p2-a") && deleted.includes("p2-b"), "page-2 policies must not be orphaned");
});

test("a list API that keeps claiming more pages still terminates", (t) => {
  const sb = sandbox([
    { method: "GET", urlIncludes: "page=1", body: policyList([OLD_A], { total_pages: 999, page: 1 }) },
    { method: "GET", urlIncludes: "page=", body: policyList([], { total_pages: 999 }) },
    { method: "POST", urlIncludes: "/policies", body: { success: true, result: { id: "new-1" } } },
    { method: "DELETE", urlIncludes: "/policies/", body: { success: true } },
  ]);
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com" });
  assert.equal(res.timedOut, false, "the pagination walk must terminate on its own");
  assert.equal(res.status, 0, res.out);

  const gets = sb.requests().filter((r) => r.method === "GET");
  assert.ok(gets.length <= 3, `an empty page must stop the walk; made ${gets.length} list calls`);
  assert.equal(deletes(sb).length, 1);
});

test("the new precedences also clear those held by page-2 policies", (t) => {
  const page1 = [policy("p1", "A", 1)];
  const page2 = [policy("p2", "B", 2), policy("p3", "C", 3)];
  const sb = sandbox([
    { method: "GET", urlIncludes: "page=1", body: policyList(page1, { total_pages: 2, page: 1 }) },
    { method: "GET", urlIncludes: "page=2", body: policyList(page2, { total_pages: 2, page: 2 }) },
    { method: "POST", urlIncludes: "/policies", body: { success: true, result: { id: "new-1" } } },
    { method: "DELETE", urlIncludes: "/policies/", body: { success: true } },
  ]);
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com" });
  assert.equal(res.status, 0, res.out);
  assert.deepEqual(posts(sb).map((r) => bodyOf(r).precedence), [4]);
});

// ── Bypass / fail-closed ──────────────────────────────────────────────

test("empty OFFICE_CIDRS creates no bypass policy at all", (t) => {
  const sb = sandbox(healthyRoutes([]));
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com", OFFICE_CIDRS: "" });
  assert.equal(res.status, 0, res.out);

  const bodies = posts(sb).map(bodyOf);
  assert.equal(bodies.length, 1, "only the allow policy may be created");
  assert.equal(bodies[0].decision, "allow");
  assert.ok(!/bypass/i.test(res.out.replace(/^.*Existing policies.*$/gm, "")), "no bypass should be reported");
});

test("an OFFICE_CIDRS of only separators and whitespace creates no bypass policy", (t) => {
  const sb = sandbox(healthyRoutes([]));
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com", OFFICE_CIDRS: " , ,\t" });
  assert.equal(res.status, 0, res.out);
  assert.deepEqual(posts(sb).map((r) => bodyOf(r).decision), ["allow"]);
});

test("fail-closed: with no grants at all, no allow policy is created but the old policies ARE removed", (t) => {
  const sb = sandbox(healthyRoutes());
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "", CLIENT_EMAILS: "", CLIENT_DOMAIN: "" });
  assert.equal(res.status, 0, res.out);

  assert.equal(posts(sb).length, 0, "an empty include list must never be POSTed (Cloudflare rejects it)");
  assert.match(res.out, /LOCKED/);
  assert.deepEqual(
    deletes(sb).map((r) => r.path.split("/").pop()),
    ["old-a", "old-b"],
    "locking is the declared intent — the stale grants must still go",
  );
});

test("an unset EMAIL_DOMAIN never silently falls back to a default staff domain", (t) => {
  const sb = sandbox(healthyRoutes([]));
  t.after(() => sb.cleanup());

  const res = runSync(sb, { CLIENT_EMAILS: "only@client.example" });
  assert.equal(res.status, 0, res.out);

  const allow = posts(sb).map(bodyOf).find((b) => b.decision === "allow");
  assert.deepEqual(allow.include, [{ email: { email: "only@client.example" } }]);
  assert.ok(
    !JSON.stringify(allow.include).includes("email_domain"),
    "no email_domain include may appear when EMAIL_DOMAIN is unset",
  );
});

test("EMAIL_DOMAIN, CLIENT_DOMAIN and CLIENT_EMAILS compose into a single allow policy", (t) => {
  const sb = sandbox(healthyRoutes([]));
  t.after(() => sb.cleanup());

  const res = runSync(sb, {
    EMAIL_DOMAIN: "staff.example",
    CLIENT_DOMAIN: "client.example",
    CLIENT_EMAILS: "one@x.example,two@y.example",
  });
  assert.equal(res.status, 0, res.out);

  const allow = posts(sb).map(bodyOf).filter((b) => b.decision === "allow");
  assert.equal(allow.length, 1, "exactly one allow policy");
  assert.deepEqual(allow[0].include, [
    { email_domain: { domain: "staff.example" } },
    { email_domain: { domain: "client.example" } },
    { email: { email: "one@x.example" } },
    { email: { email: "two@y.example" } },
  ]);
});

// ── Delete failures ───────────────────────────────────────────────────

test("a failed DELETE of an old policy warns but does not fail the deploy (the new policies are live)", (t) => {
  const sb = sandbox([
    { method: "GET", urlIncludes: "page=1", body: policyList([OLD_A, OLD_B]) },
    { method: "POST", urlIncludes: "/policies", body: { success: true, result: { id: "new-1" } } },
    {
      method: "DELETE",
      urlIncludes: "/policies/old-a",
      body: { success: false, errors: [{ code: 10011, message: "reusable policy" }] },
    },
    { method: "DELETE", urlIncludes: "/policies/", body: { success: true } },
  ]);
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com" });

  assert.equal(res.status, 0, res.out);
  assert.match(res.out, /::warning::Failed to delete old policy/);
  assert.equal(deletes(sb).length, 2, "one undeletable policy must not stop the rest of the cleanup");
  assert.match(res.out, /Policy sync complete/);
});

// ── Required configuration ────────────────────────────────────────────

for (const missing of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "APP_ID"]) {
  test(`a missing ${missing} fails immediately with zero Cloudflare calls`, (t) => {
    const sb = sandbox(healthyRoutes());
    t.after(() => sb.cleanup());

    const res = runSync(sb, { [missing]: "" });

    assert.notEqual(res.status, 0);
    assert.match(res.out, new RegExp(`${missing} is required`));
    assert.deepEqual(sb.calls(), []);
  });
}

test("the app id from the environment is the one every request addresses", (t) => {
  const sb = sandbox(healthyRoutes());
  t.after(() => sb.cleanup());

  const res = runSync(sb, { EMAIL_DOMAIN: "example.com" });
  assert.equal(res.status, 0, res.out);

  for (const r of sb.requests()) {
    assert.ok(r.path.startsWith(POLICIES_PATH), `unexpected endpoint ${r.path}`);
    assert.ok(r.url.includes(APP_ID));
  }
});
