/**
 * Card credits (18/11/2026, replaces the PayGate proxy on Railway).
 * Run: bun test. Supabase, Stripe and Resend are faked at fetch level; the agent is mocked. Nothing paid runs.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";

Object.assign(process.env, {
  SUPABASE_URL: "http://supabase.test", SUPABASE_SERVICE_KEY: "test-service", ANTHROPIC_API_KEY: "test-anthropic",
  PAYGATE_AUTH_SECRET: "pg-secret", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_test", RESEND_API_KEY: "re_test",
});

let agentRuns = 0;
let agentBehaviour: () => Promise<string> = async () => "ran";
const runAgent = async () => { agentRuns++; return { response: await agentBehaviour(), tool_calls_made: [], tokens_used: 1, costs: {}, cost_usd: 0 }; };
mock.module("../src/agent.ts", () => ({ runAgent }));
mock.module("../src/agent.js", () => ({ runAgent }));

// ── In-memory stand-in for the credit_* SQL functions (same rules as migration 005) ──
type Key = { agent: string; credits: number; active: boolean };
let keys: Map<string, Key>;
let ledger: { id: number; hash: string; delta: number; reason: string; ref?: string }[];
let rpcCalls: string[];
let stripeBodies: string[];
const h = (k: string) => createHash("sha256").update(k).digest("hex");

function rpc(fn: string, a: any): any {
  rpcCalls.push(fn);
  if (fn === "credit_charge") {
    const k = keys.get(a.p_key_hash);
    if (k && k.agent === a.p_agent && k.active && k.credits >= a.p_amount) {
      k.credits -= a.p_amount;
      const id = ledger.length + 1; ledger.push({ id, hash: a.p_key_hash, delta: -a.p_amount, reason: "charge" });
      return [{ ok: true, charge_id: id, balance: k.credits, reason: null }];
    }
    if (!k || k.agent !== a.p_agent) return [{ ok: false, charge_id: null, balance: 0, reason: "not_found" }];
    return [{ ok: false, charge_id: null, balance: k.credits, reason: k.active ? "insufficient" : "inactive" }];
  }
  if (fn === "credit_refund") {
    const c = ledger.find((l) => l.id === a.p_charge_id && l.reason === "charge")!;
    const k = keys.get(c.hash)!;
    if (!ledger.some((l) => l.reason === "refund" && l.ref === String(c.id))) {
      k.credits -= c.delta; ledger.push({ id: ledger.length + 1, hash: c.hash, delta: -c.delta, reason: "refund", ref: String(c.id) });
    }
    return k.credits;
  }
  if (fn === "credit_topup") {
    if (!keys.has(a.p_key_hash)) keys.set(a.p_key_hash, { agent: a.p_agent, credits: 0, active: true });
    const k = keys.get(a.p_key_hash)!;
    if (ledger.some((l) => l.reason === "topup" && l.ref === a.p_ref)) return [{ applied: false, balance: k.credits }];
    k.credits += a.p_credits; ledger.push({ id: ledger.length + 1, hash: a.p_key_hash, delta: a.p_credits, reason: "topup", ref: a.p_ref });
    return [{ applied: true, balance: k.credits }];
  }
  throw new Error("unknown rpc " + fn);
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const json = (b: any) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (url.host === "supabase.test") {
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (m) return json(rpc(m[1], JSON.parse(String(init?.body))));
    if (url.pathname === "/rest/v1/credit_keys") {
      const hash = url.searchParams.get("key_hash")!.replace("eq.", "");
      const agent = url.searchParams.get("agent")!.replace("eq.", "");
      const k = keys.get(hash);
      return json(k && k.agent === agent ? [{ credits: k.credits }] : []);
    }
  }
  if (url.host === "api.stripe.com") { stripeBodies.push(String(init?.body)); return json({ url: "https://checkout.stripe.test/s" }); }
  if (url.host === "api.resend.com") return json({ id: "email_1" });
  throw new Error("no network in tests: " + url);
}) as typeof fetch;

const { default: mcp } = await import("../api/mcp.ts");
const { default: webhook } = await import("../api/stripe-webhook.ts");
const { default: checkout } = await import("../api/checkout.ts");
const { PRICES, paidRun } = await import("../api/_credits.ts");

const KEY = "pg_" + "a".repeat(48);
const POOR = "pg_" + "b".repeat(48);

beforeEach(() => {
  keys = new Map([[h(KEY), { agent: "verity", credits: 707, active: true }], [h(POOR), { agent: "verity", credits: 1, active: true }]]);
  ledger = []; rpcCalls = []; stripeBodies = []; agentRuns = 0; agentBehaviour = async () => "ran";
});

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined as any, headers: {} as Record<string, string> };
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.redirect = (c: number, u: string) => { r.statusCode = c; r.location = u; return r; };
  r.end = () => r;
  return r;
}
async function call(tool: string, headers: Record<string, string>, args: any = { claim: "The Eiffel Tower is in Paris" }, query: any = {}) {
  const res = fakeRes();
  await mcp({ method: "POST", query, headers, body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } } } as any, res);
  return res.body;
}

test("prices are exactly what PayGate charged", () => {
  const paygate = "verity_verify:10,verity_deep_check:50,verity_batch:75,verity_agent:10";
  for (const pair of paygate.split(",")) { const [t, p] = pair.split(":"); expect(PRICES[t]).toBe(Number(p)); }
  expect(PRICES.check_credits).toBe(1); // PayGate's default price for unlisted tools
});

test("a paid call takes the tool's price and runs the work once", async () => {
  const body = await call("verity_deep_check", { "x-api-key": KEY });
  expect(body.result.content[0].text).toBe("ran");
  expect(agentRuns).toBe(1);
  expect(keys.get(h(KEY))!.credits).toBe(657);
});

test("Authorization: Bearer pg_… works like X-Api-Key", async () => {
  await call("verity_verify", { authorization: `Bearer ${KEY}` });
  expect(keys.get(h(KEY))!.credits).toBe(697);
});

test("a failed call is refunded in full and says so", async () => {
  agentBehaviour = async () => { throw new Error("upstream broke"); };
  const body = await call("verity_deep_check", { "x-api-key": KEY });
  expect(body.error.message).toContain("Not charged");
  expect(keys.get(h(KEY))!.credits).toBe(707);
  expect(ledger.map((l) => l.reason)).toEqual(["charge", "refund"]);
});

test("a call cut off by the time limit is refunded", async () => {
  const run = await paidRun(KEY, "verity_batch", () => new Promise<string>(() => {}), 20);
  expect(run.ok).toBe(false);
  expect("refunded" in run && run.refunded).toBe(true);
  expect(keys.get(h(KEY))!.credits).toBe(707);
});

test("too few credits: -32402, no work, no charge", async () => {
  const body = await call("verity_deep_check", { "x-api-key": POOR });
  expect(body.error.code).toBe(-32402);
  expect(body.error.message).toContain("Insufficient credits");
  expect(agentRuns).toBe(0);
  expect(keys.get(h(POOR))!.credits).toBe(1);
});

test("an unknown or malformed key: -32402, no work", async () => {
  for (const k of ["pg_" + "c".repeat(48), "not-a-key"]) {
    const body = await call("verity_verify", { "x-api-key": k });
    expect(body.error.code).toBe(-32402);
  }
  expect(agentRuns).toBe(0);
});

test("calls still proxied by the old Railway PayGate (pg_token) are not charged twice", async () => {
  const body = await call("verity_verify", { "x-api-key": KEY }, { query: "q" }, { pg_token: "pg-secret" });
  expect(body.result.content[0].text).toBe("ran");
  expect(rpcCalls).toHaveLength(0);
  expect(keys.get(h(KEY))!.credits).toBe(707);
});

test("no key and no pg_token: payment message, nothing runs", async () => {
  const body = await call("verity_verify", {});
  expect(JSON.stringify(body)).toContain("Payment not configured");
  expect(agentRuns).toBe(0);
});

test("check_credits with a key header costs 1 credit, as on PayGate; without one it is a free lookup", async () => {
  const paid = await call("check_credits", { "x-api-key": KEY }, {});
  expect(paid.result.content[0].text).toContain("706 credits remaining");
  const free = await call("check_credits", {}, { key: KEY });
  expect(free.result.content[0].text).toContain("706 credits remaining");
  const missing = await call("check_credits", {}, { key: "pg_" + "d".repeat(48) });
  expect(missing.result.content[0].text).toContain("Key not found");
});

function signedEvent(session: any) {
  const payload = JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", data: { object: session } });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${payload}`).digest("hex")}`;
  const req: any = {
    method: "POST", headers: { "stripe-signature": sig },
    on(ev: string, cb: any) { if (ev === "data") cb(Buffer.from(payload)); if (ev === "end") cb(); return req; },
  };
  return req;
}
const NEW = "pg_" + "e".repeat(48);
const session = (over: any = {}) => ({
  id: "cs_test_1", object: "checkout.session", created: 1, payment_status: "paid",
  customer_details: { email: "buyer@example.com" },
  metadata: { agent: "verity", pack: "starter", paygate_api_key: NEW, paygate_credits: "1000" }, ...over,
});

test("a paid checkout tops up its key once, even when Stripe repeats the event", async () => {
  for (let i = 0; i < 2; i++) { const res = fakeRes(); await webhook(signedEvent(session()), res); expect(res.statusCode).toBe(200); }
  expect(keys.get(h(NEW))!.credits).toBe(1000);
  expect(ledger.filter((l) => l.reason === "topup")).toHaveLength(1);
});

test("another product's checkout on the same Stripe account is ignored", async () => {
  const res = fakeRes();
  await webhook(signedEvent(session({ metadata: { ...session().metadata, agent: "aeonos" } })), res);
  expect(keys.has(h(NEW))).toBe(false);
});

test("a bad signature is refused and adds nothing", async () => {
  const req = signedEvent(session()); req.headers["stripe-signature"] = "t=1,v1=bad";
  const res = fakeRes(); await webhook(req, res);
  expect(res.statusCode).toBe(400);
  expect(keys.has(h(NEW))).toBe(false);
});

test("checkout makes a PayGate-format key, puts it in the session, and stores nothing before payment", async () => {
  const res = fakeRes();
  await checkout({ method: "GET", query: { pack: "pro" }, headers: {} } as any, res);
  expect(res.statusCode).toBe(303);
  const body = new URLSearchParams(stripeBodies[0]);
  expect(body.get("metadata[paygate_api_key]")).toMatch(/^pg_[0-9a-f]{48}$/);
  expect(body.get("metadata[paygate_credits]")).toBe("6000");
  expect(body.get("line_items[0][price_data][unit_amount]")).toBe("5000");
  expect(body.get("success_url")).toContain(body.get("metadata[paygate_api_key]")!);
  expect(rpcCalls).toHaveLength(0);
});
