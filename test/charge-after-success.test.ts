/**
 * Charge only after the work succeeds (22/10/2026). Run: bun test
 * The facilitator, the agent, Supabase and every HTTP call are mocked: no test can settle a real payment
 * or make a paid model call. Any fetch to an unexpected URL throws.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

Object.assign(process.env, {
  SUPABASE_URL: "http://localhost:1", SUPABASE_SERVICE_KEY: "test-service", ANTHROPIC_API_KEY: "test-anthropic",
  RESEND_API_KEY: "test-resend", NOTIFY_EMAIL: "alerts@example.com",
  TELEGRAM_BOT_TOKEN: "test-telegram", TELEGRAM_CHAT_ID: "123",
  CDP_API_KEY_NAME: "test-cdp-name", CDP_API_KEY_PRIVATE_KEY: "test-cdp-key",
});

const state = {
  verifyValid: true,
  settleOk: true,
  settleCalls: 0,
  // Facilitator replies, one per settle call; when empty, settleOk decides.
  settleScript: [] as ("pending" | "pending-no-tx" | "pending-throw")[],
  settlePayloads: [] as string[],
  agent: "ok" as "ok" | "throw",
  logFails: false,
  /** Database starts failing the moment settlement succeeds (charged, then the save fails). */
  dbFailsAfterSettle: false,
  /** Promises handed to waitUntil (@vercel/functions is mocked below). */
  waited: [] as Promise<unknown>[],
  emails: [] as any[],
  telegrams: [] as any[],
  claims: new Set<string>(),
  claimDbDown: false,
};

// Patch the facilitator on its prototype so both the shared gate's client and api/agent.ts's own client
// are covered, whichever test file loaded them first.
const { HTTPFacilitatorClient } = await import("@x402/core/server");
const { SettleError } = await import("@x402/core/types");
(HTTPFacilitatorClient.prototype as any).verify = async () =>
  state.verifyValid ? { isValid: true } : { isValid: false, invalidReason: "invalid_signature" };
(HTTPFacilitatorClient.prototype as any).settle = async (payload: unknown) => {
  state.settleCalls++;
  if (state.dbFailsAfterSettle) state.logFails = true;
  state.settlePayloads.push(JSON.stringify(payload));
  const step = state.settleScript.shift();
  const pending = { success: false, errorReason: "settlement_pending", transaction: "0xpendingtx", network: "eip155:8453" };
  if (step === "pending") return pending;
  if (step === "pending-no-tx") return { ...pending, transaction: "" };
  if (step === "pending-throw") throw new SettleError(502, pending as any);
  return state.settleOk ? { success: true, transaction: "0xabc", network: "eip155:8453" } : { success: false, errorReason: "insufficient_funds" };
};

const runAgent = async () => {
  if (state.agent === "throw") throw new Error("anthropic 529 overloaded");
  return { response: '{"verdict":"CURRENT","confidence":90}', tool_calls_made: [], tokens_used: 10, costs: {}, cost_usd: 0 };
};
mock.module("../src/agent.ts", () => ({ runAgent }));
mock.module("../src/agent.js", () => ({ runAgent }));

// Chainable Supabase stub: every call returns itself, awaiting it gives an empty row.
const chain = (): any => {
  const done = state.logFails
    ? Promise.reject(new Error("db down"))
    : Promise.resolve({ data: { id: "task-1", query_count: 0 }, error: null });
  done.catch(() => {}); // avoid unhandled-rejection noise for chains nobody awaits
  return new Proxy(() => {}, {
    get: (_t, k) => (k === "then" ? done.then.bind(done) : k === "catch" ? done.catch.bind(done) : () => chain()),
    apply: () => chain(),
  });
};
// payment_claims behaves like the real table: a second insert of the same id fails on the primary key.
const claimsTable = () => ({
  insert: async ({ id }: { id: string }) => {
    if (state.claimDbDown) return { data: null, error: { code: "08006", message: "connection failure" } };
    if (state.claims.has(id)) return { data: null, error: { code: "23505", message: "duplicate key" } };
    state.claims.add(id);
    return { data: null, error: null };
  },
});
mock.module("@vercel/functions", () => ({ waitUntil: (p: Promise<unknown>) => { state.waited.push(p); } }));
mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (t: string) => (t === "payment_claims" ? claimsTable() : chain()),
    schema: () => ({ from: () => chain() }),
  }),
}));

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "https://api.resend.com/emails") {
    state.emails.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }
  if (url === "https://api.telegram.org/bottest-telegram/sendMessage") {
    state.telegrams.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }
  throw new Error(`unexpected fetch in test: ${url}`);
}) as typeof fetch;

function fakeRes() {
  const r: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as any, events: [] as any[], ended: false };
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.write = (chunk: string) => { r.events.push(JSON.parse(chunk.replace(/^data: /, ""))); return true; };
  r.end = () => { r.ended = true; return r; };
  return r;
}

// Each call gets its own signed payment unless one is passed in (to test reuse).
let nonce = 0;
// Shaped like a real EIP-3009 payment: payer + one-time nonce inside `authorization`.
const paymentObj = (n: number, from = "0xBuyer000000000000000000000000000000000001") => ({
  x402Version: 2,
  payload: {
    signature: `0xsig${n}`,
    authorization: { from, to: "0x400d65bb174c546ed92f5d61ce21fbde96b8bacc", value: "100000", validAfter: "0", validBefore: "9999999999", nonce: `0x${n.toString(16).padStart(64, "0")}` },
  },
});
const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const newPayment = () => encode(paymentObj(++nonce));
const paidReq = (query: Record<string, string> = {}, payment = newPayment()) => ({  // claim sent as `query`; verify.ts accepts both
  method: "POST",
  headers: { "payment-signature": payment, "content-type": "application/json" },
  body: { query: "The Eiffel Tower is 330 m tall", caller_id: "acme.com" },
  query,
});

const { default: verify } = await import("../api/verify.ts");
const { default: agent } = await import("../api/agent.ts");

beforeEach(() => {
  state.verifyValid = true; state.settleOk = true; state.settleCalls = 0; state.agent = "ok"; state.logFails = false; state.dbFailsAfterSettle = false; state.waited = []; state.emails = [];
  state.telegrams = []; state.claimDbDown = false; state.settleScript = []; state.settlePayloads = [];
  process.env.CDP_API_KEY_NAME = "test-cdp-name"; process.env.CDP_API_KEY_PRIVATE_KEY = "test-cdp-key";
});

describe("x402 routes charge only after the work succeeds", () => {
  test("verify: success settles once and returns the result with the payment receipt", async () => {
    const res = fakeRes();
    await verify(paidReq() as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(state.settleCalls).toBe(1);
    expect(res.headers["payment-response"]).toBeTruthy();
  });

  test("verify: when the work fails the buyer is not charged, gets a clean message, and Carly is emailed", async () => {
    state.agent = "throw";
    const res = fakeRes();
    await verify(paidReq() as any, res);
    expect(state.settleCalls).toBe(0);
    expect(res.statusCode).toBe(503);
    expect(res.body.charged).toBe(false);
    expect(res.body.error).toContain("payment was not taken");
    expect(res.body.error).not.toContain("529"); // no raw provider error shown to the buyer
    expect(state.emails).toHaveLength(1);
    expect(state.emails[0].subject).toContain("not charged");
    expect(state.telegrams).toHaveLength(1);
    expect(state.telegrams[0].text).toContain("not charged");
  });

  test("verify: if settlement fails the result is withheld (402), not given away", async () => {
    state.settleOk = false;
    const res = fakeRes();
    await verify(paidReq() as any, res);
    expect(state.settleCalls).toBe(1);
    expect(res.statusCode).toBe(402);
    expect(JSON.stringify(res.body)).not.toContain('"confidence":90');
  });

  test("verify: a settlement failure after the work succeeded alerts Carly by email and Telegram", async () => {
    state.settleOk = false;
    await verify(paidReq() as any, fakeRes());
    expect(state.emails).toHaveLength(1);
    expect(state.emails[0].subject).toContain("failed to settle");
    expect(state.telegrams).toHaveLength(1);
    expect(state.telegrams[0].text).toContain("failed to settle");
  });

  test("alerts stay silent when Telegram is not configured", async () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      state.agent = "throw";
      await verify(paidReq() as any, fakeRes());
      expect(state.emails).toHaveLength(1);
      expect(state.telegrams).toHaveLength(0);
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = saved;
    }
  });

  test("verify: settlement_pending is retried once with the identical payload, then succeeds", async () => {
    state.settleScript = ["pending"];
    const res = fakeRes();
    await verify(paidReq() as any, res);
    expect(state.settleCalls).toBe(2);
    expect(state.settlePayloads[0]).toBe(state.settlePayloads[1]);
    expect(res.statusCode).toBe(200);
    expect(res.headers["payment-response"]).toBeTruthy();
    expect(state.emails).toHaveLength(0);
  });

  test("verify: still pending after the retry delivers the result and alerts Carly with the tx hash", async () => {
    state.settleScript = ["pending", "pending-throw"]; // second reply arrives as a non-2xx SettleError
    const res = fakeRes();
    await verify(paidReq() as any, res);
    expect(state.settleCalls).toBe(2);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(JSON.stringify(res.body)).not.toContain("Nothing was charged");
    expect(state.emails).toHaveLength(1);
    expect(state.emails[0].subject).toContain("pending");
    expect(state.emails[0].text).toContain("0xpendingtx");
    expect(state.emails[0].text).not.toContain("nothing was charged");
    expect(state.telegrams).toHaveLength(1);
    expect(state.telegrams[0].text).toContain("0xpendingtx");
  });

  test("verify: pending without a tx hash is not retried, but still delivered and alerted", async () => {
    state.settleScript = ["pending-no-tx"];
    const res = fakeRes();
    await verify(paidReq() as any, res);
    expect(state.settleCalls).toBe(1);
    expect(res.statusCode).toBe(200);
    expect(state.emails).toHaveLength(1);
    expect(state.emails[0].text).toContain("none reported");
  });

  test("agent (stream): still pending delivers the result, never says nothing was charged", async () => {
    state.settleScript = ["pending", "pending"];
    const res = fakeRes();
    await agent(paidReq({ stream: "true" }) as any, res);
    const last = res.events.at(-1);
    expect(last.status).toBe("completed");
    expect(JSON.stringify(res.events)).not.toContain("Nothing was charged");
    expect(state.settleCalls).toBe(2);
    expect(state.emails).toHaveLength(1);
  });

  test("verify: the same signed payment can't buy the work twice", async () => {
    const payment = newPayment();
    const first = fakeRes();
    await verify(paidReq({}, payment) as any, first);
    expect(first.statusCode).toBe(200);
    state.agent = "throw"; // would alert if the work ran again
    const second = fakeRes();
    await verify(paidReq({}, payment) as any, second);
    expect(second.statusCode).toBe(409);
    expect(second.body.charged).toBe(false);
    expect(second.body.error).toContain("already been used");
    expect(state.settleCalls).toBe(1);
    expect(state.emails).toHaveLength(0);
  });

  test("verify: re-encoding the same payment (reordered JSON, different case) can't buy the work twice", async () => {
    const n = ++nonce;
    const original = paymentObj(n);
    await verify(paidReq({}, encode(original)) as any, fakeRes());
    const a = original.payload.authorization;
    const reordered = { payload: { authorization: { nonce: a.nonce.toUpperCase().replace("0X", "0x"), validBefore: a.validBefore, validAfter: a.validAfter, value: a.value, to: a.to, from: a.from.toLowerCase() }, signature: original.payload.signature }, x402Version: 2 };
    state.agent = "throw";
    const second = fakeRes();
    await verify(paidReq({}, encode(reordered)) as any, second);
    expect(second.statusCode).toBe(409);
    expect(state.settleCalls).toBe(1);
  });

  test("verify: two parallel requests with one payment run the work once", async () => {
    const payment = newPayment();
    const [a, b] = [fakeRes(), fakeRes()];
    await Promise.all([verify(paidReq({}, payment) as any, a), verify(paidReq({}, payment) as any, b)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(state.settleCalls).toBe(1);
  });

  test("verify: if the payment can't be claimed the work doesn't start and nothing is charged", async () => {
    state.claimDbDown = true;
    state.agent = "throw";
    const res = fakeRes();
    await verify(paidReq() as any, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.charged).toBe(false);
    expect(state.settleCalls).toBe(0);
    expect(state.emails).toHaveLength(0);
  });

  test("agent: the same signed payment can't buy the work twice", async () => {
    const payment = newPayment();
    await agent(paidReq({}, payment) as any, fakeRes());
    const second = fakeRes();
    await agent(paidReq({}, payment) as any, second);
    expect(second.statusCode).toBe(409);
    expect(state.settleCalls).toBe(1);
  });

  test("without CDP keys paid calls fail closed (500) instead of using the default facilitator", async () => {
    delete process.env.CDP_API_KEY_NAME;
    state.agent = "throw"; // would alert if the work ran
    const claimsBefore = state.claims.size;
    for (const route of [verify, agent]) {
      const res = fakeRes();
      await route(paidReq() as any, res);
      expect(res.statusCode).toBe(500);
      expect(res.body.error).toBe("payments not configured");
    }
    expect(state.settleCalls).toBe(0);
    expect(state.claims.size).toBe(claimsBefore); // refused before the payment was claimed
    expect(state.emails).toHaveLength(0);
  });

  test("verify: an invalid payment never runs the work", async () => {
    state.verifyValid = false;
    state.agent = "throw"; // would email if the work ran
    const res = fakeRes();
    await verify(paidReq() as any, res);
    expect(res.statusCode).toBe(402);
    expect(state.settleCalls).toBe(0);
    expect(state.emails).toHaveLength(0);
  });

  test("a failed log write after payment still delivers the result (never says 'not charged' after charging)", async () => {
    state.logFails = true;
    const res = fakeRes();
    await verify(paidReq() as any, res);
    expect(state.settleCalls).toBe(1);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(state.emails).toHaveLength(0);
  });

  test("agent (sync): failure is not charged and the buyer sees the not-charged message", async () => {
    state.agent = "throw";
    const res = fakeRes();
    await agent(paidReq() as any, res);
    expect(state.settleCalls).toBe(0);
    expect(JSON.stringify(res.body)).toContain("payment was not taken");
    expect(state.emails).toHaveLength(1);
  });

  test("agent (sync): success settles once", async () => {
    const res = fakeRes();
    await agent(paidReq() as any, res);
    expect(state.settleCalls).toBe(1);
    expect(res.body.status).toBe("completed");
    expect(res.headers["payment-response"]).toBeTruthy();
  });

  test("agent (stream): failure ends with charged=false and never settles", async () => {
    state.agent = "throw";
    const res = fakeRes();
    await agent(paidReq({ stream: "true" }) as any, res);
    const last = res.events.at(-1);
    expect(last.status).toBe("failed");
    expect(last.charged).toBe(false);
    expect(state.settleCalls).toBe(0);
    expect(res.ended).toBe(true);
  });

  test("agent (stream): success settles once and puts the receipt in the final event", async () => {
    const res = fakeRes();
    await agent(paidReq({ stream: "true" }) as any, res);
    const last = res.events.at(-1);
    expect(last.status).toBe("completed");
    expect(last.payment_response).toBeTruthy();
    expect(state.settleCalls).toBe(1);
  });

  test("agent (async): failure is not charged", async () => {
    state.agent = "throw";
    const res = fakeRes();
    await agent(paidReq({ async: "true" }) as any, res);
    expect(res.body.task_id).toBe("task-1");
    expect(state.waited).toHaveLength(1); // runs under waitUntil so Vercel doesn't cut it off
    await Promise.all(state.waited);
    expect(state.settleCalls).toBe(0);
    expect(state.emails).toHaveLength(1);
  });

  test("agent (async): charged, then the result can't be saved: Carly is told it was CHARGED, never 'not charged'", async () => {
    state.dbFailsAfterSettle = true;
    await agent(paidReq({ async: "true" }) as any, fakeRes());
    await Promise.all(state.waited);
    expect(state.settleCalls).toBe(1);
    expect(state.emails).toHaveLength(1);
    expect(state.emails[0].subject).toContain("charged but");
    expect(state.emails[0].subject + state.emails[0].text).not.toMatch(/not charged|nothing was charged|not taken/i);
  });
});
