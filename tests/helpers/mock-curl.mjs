#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────
// mock-curl.mjs — a scripted stand-in for curl(1).
//
// The harness drops an executable `curl` shim on PATH that execs this file, so
// every script under test talks to it instead of the real Cloudflare API. It
// does two jobs:
//
//   1. RECORD every invocation (method, url, path, query, body, headers) as one
//      JSON object per line in $MOCK_CURL_LOG. Tests assert on the exact call
//      SEQUENCE, not just the outcome — the lockout bugs this suite guards
//      against were ordering bugs, invisible to an outcome-only assertion.
//   2. REPLY from a scripted route table at $MOCK_CURL_SCRIPT.
//
// Route table (JSON):
//   { "routes": [ {
//        "method":      "POST",            // optional, exact match
//        "urlIncludes": "/policies",       // optional, substring of the URL
//        "urlRegex":    "policies\\?page=2", // optional
//        "bodyIncludes":"bypass",          // optional, substring of --data
//        "times":       1,                 // optional, retire after N matches
//        "status":      200,               // optional, for -w '%{http_code}'
//        "body":        { "success": true },// JSON value, serialized to stdout
//        "bodyText":    "raw",             // ...or raw text instead
//        "exit":        7,                 // optional, simulate curl failure
//        "stderr":      "could not connect"
//      } ] }
//
// First matching non-retired route wins. An unmatched request is recorded and
// answered with success:false naming the request, so a test that forgets a
// route fails with a readable message rather than a silent hang.
// ──────────────────────────────────────────────────────────────────────
import { appendFileSync, readFileSync, existsSync } from "node:fs";

const LOG = process.env.MOCK_CURL_LOG;
const SCRIPT = process.env.MOCK_CURL_SCRIPT;

// curl flags that consume the following argument.
const VALUED = new Set([
  "-X", "--request",
  "-H", "--header",
  "-d", "--data", "--data-raw", "--data-binary",
  "-o", "--output",
  "-w", "--write-out",
  "--max-time", "--connect-timeout", "--retry",
  "-u", "--user", "-A", "--user-agent", "-e", "--referer",
]);

function parseArgs(argv) {
  const out = { method: null, url: null, body: null, headers: [], writeOut: null, output: null, flags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED.has(a)) {
      const v = argv[++i];
      if (a === "-X" || a === "--request") out.method = v;
      else if (a === "-H" || a === "--header") out.headers.push(v);
      else if (a === "-d" || a.startsWith("--data")) out.body = v;
      else if (a === "-w" || a === "--write-out") out.writeOut = v;
      else if (a === "-o" || a === "--output") out.output = v;
    } else if (a.startsWith("-") && a !== "-") {
      out.flags.push(a);
    } else if (out.url === null) {
      out.url = a;
    }
  }
  if (!out.method) out.method = out.body === null ? "GET" : "POST";
  return out;
}

function splitUrl(url) {
  try {
    const u = new URL(url);
    return { path: u.pathname, query: u.search.replace(/^\?/, "") };
  } catch {
    return { path: url ?? "", query: "" };
  }
}

function matches(route, req) {
  if (route.method && route.method !== req.method) return false;
  if (route.urlIncludes && !req.url.includes(route.urlIncludes)) return false;
  if (route.urlRegex && !new RegExp(route.urlRegex).test(req.url)) return false;
  if (route.bodyIncludes && !(req.body ?? "").includes(route.bodyIncludes)) return false;
  return true;
}

function priorUses(logPath) {
  const used = new Map();
  if (!logPath || !existsSync(logPath)) return used;
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (typeof rec.routeIndex === "number" && rec.routeIndex >= 0) {
      used.set(rec.routeIndex, (used.get(rec.routeIndex) ?? 0) + 1);
    }
  }
  return used;
}

const parsed = parseArgs(process.argv.slice(2));
const { path, query } = splitUrl(parsed.url ?? "");
const req = {
  method: parsed.method,
  url: parsed.url ?? "",
  path,
  query,
  body: parsed.body,
  headers: parsed.headers,
};

const script = SCRIPT && existsSync(SCRIPT) ? JSON.parse(readFileSync(SCRIPT, "utf8")) : { routes: [] };
const used = priorUses(LOG);

let routeIndex = -1;
let route = null;
for (let i = 0; i < (script.routes ?? []).length; i++) {
  const r = script.routes[i];
  if (typeof r.times === "number" && (used.get(i) ?? 0) >= r.times) continue;
  if (!matches(r, req)) continue;
  routeIndex = i;
  route = r;
  break;
}

if (LOG) appendFileSync(LOG, JSON.stringify({ ...req, routeIndex }) + "\n");

if (!route) {
  const body = {
    success: false,
    errors: [{ code: 9999, message: `MOCK CURL: unmatched request ${req.method} ${req.url}` }],
  };
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}

if (route.stderr) process.stderr.write(String(route.stderr));

const status = route.status ?? 200;
const payload =
  route.bodyText !== undefined ? String(route.bodyText)
  : route.body !== undefined ? JSON.stringify(route.body)
  : "";

// `-o <file>` suppresses the body on stdout (only /dev/null is honoured; tests
// never need a real capture file).
if (!parsed.output) process.stdout.write(payload);
if (parsed.writeOut) {
  process.stdout.write(
    parsed.writeOut.replace(/%\{http_code\}/g, String(status)).replace(/\\n/g, "\n"),
  );
}

process.exit(route.exit ?? 0);
