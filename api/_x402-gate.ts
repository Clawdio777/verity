/**
 * api/_x402-gate.ts — VERITY shared x402 v2 payment gate
 * Underscore prefix = Vercel does not expose this as a route.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { SettleError, type PaymentRequired, type PaymentPayload, type PaymentRequirements } from "@x402/core/types";
import { x402Version as X402_VERSION } from "@x402/core";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension } from "@x402/extensions";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

export const facilitatorClient = new HTTPFacilitatorClient(
  process.env.CDP_API_KEY_NAME && process.env.CDP_API_KEY_PRIVATE_KEY
    ? createFacilitatorConfig(
        process.env.CDP_API_KEY_NAME.trim(),
        process.env.CDP_API_KEY_PRIVATE_KEY.trim()
      )
    : {}
);

// Without CDP keys the client above points at the default x402.org facilitator, which does not settle
// Base mainnet for us. Paid routes refuse with 500 instead of quietly using it (fail closed).
export const PAYMENTS_NOT_CONFIGURED = "payments not configured";
export function paymentsConfigured(): boolean {
  return !!(process.env.CDP_API_KEY_NAME?.trim() && process.env.CDP_API_KEY_PRIVATE_KEY?.trim());
}

// Obvious placeholder for the discovery listing, so a copied example is clearly not a real caller id.
export const DISCOVERY_CALLER_ID_EXAMPLE = "YOUR-AGENT-OR-DOMAIN-ID";

const PAYMENT_ADDRESS = "0x400d65bb174c546ed92f5d61ce21fbde96b8bacc";
const USDC_ASSET      = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function buildPaymentReqs(priceUsdc: number): PaymentRequirements {
  return {
    scheme:            "exact",
    network:           "eip155:8453",
    amount:            String(Math.round(priceUsdc * 1_000_000)),
    payTo:             (process.env.PAYMENT_ADDRESS || PAYMENT_ADDRESS).trim(),
    maxTimeoutSeconds: 600, // room to finish the work (up to 300 s) before settling
    asset:             USDC_ASSET,
    extra:             { name: "USD Coin", version: "2" },
  };
}

export function buildBazaarExtension(opts: {
  serviceName: string;
  queryDescription: string;
  queryExample: string;
  outputExample: string;
}) {
  const base = declareDiscoveryExtension({
    bodyType: "json",
    input: { query: opts.queryExample, caller_id: DISCOVERY_CALLER_ID_EXAMPLE },
    inputSchema: {
      properties: {
        query:     { type: "string", description: opts.queryDescription },
        caller_id: { type: "string", description: "Optional agent or user ID for persistent memory." },
      },
      required: ["query"],
    },
    output: {
      example: { status: "completed", artifact: { parts: [{ type: "text", text: opts.outputExample }], index: 0 } },
      schema: {
        properties: {
          status:   { type: "string" },
          artifact: { type: "object" },
          tokens:   { type: "number" },
        },
      },
    },
  });

  return {
    bazaar: {
      ...base.bazaar,
      info: {
        ...base.bazaar.info,
        input: { ...base.bazaar.info.input, method: "POST" },
      },
      serviceName: opts.serviceName,
      tags: ["fact-check", "verification", "data-freshness", "hallucination", "ai-verification"],
      iconUrl: "https://verity.basechainlabs.com/verity-logo.jpg",
    },
  };
}

export function send402(
  res: VercelResponse,
  paymentReqs: PaymentRequirements,
  bazaarExtension: Record<string, unknown>,
  resourceUrl: string,
  resourceDesc: string,
  errorReason?: string
) {
  const body: PaymentRequired = {
    x402Version: X402_VERSION,
    error:       errorReason ?? "payment-required",
    resource:    { url: resourceUrl, description: resourceDesc, mimeType: "application/json" },
    accepts:     [paymentReqs],
    extensions:  bazaarExtension,
  };
  res.setHeader("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(body)).toString("base64"));
  return res.status(402).json(body);
}

// ── Charge only after the work succeeds (22/10/2026, same fix as AEONOS #42) ──
// Before: the payment was settled first and the work ran after, so a failed run (model error, outage)
// left the buyer charged with nothing to show. Now: verifyPayment() checks the signed payment, the
// route does the work, and settlePayment() takes the money only once there is a result to deliver.
// If the work fails, sendNotCharged() tells the buyer nothing was taken and alerts Carly.
export interface PendingPayment {
  /** Raw payment header, for query_log ("internal-bypass" for PayGated calls). */
  header: string;
  payload?: PaymentPayload;
  reqs?: PaymentRequirements;
}

// Returns the verified and claimed (not yet settled) payment, or null if a response was already sent.
export async function verifyPayment(
  req: VercelRequest,
  res: VercelResponse,
  priceUsdc: number,
  bazaarExtension: Record<string, unknown>,
  resourceUrl: string,
  resourceDesc: string
): Promise<PendingPayment | null> {
  // PayGated internal bypass — request already authenticated + billed via credit system
  const internalKey = req.headers["x-internal-key"] as string | undefined;
  if (internalKey && process.env.INTERNAL_API_KEY && internalKey === process.env.INTERNAL_API_KEY) {
    return { header: "internal-bypass" };
  }

  const paymentReqs    = buildPaymentReqs(priceUsdc);
  const xPaymentHeader = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;

  if (!xPaymentHeader) {
    send402(res, paymentReqs, bazaarExtension, resourceUrl, resourceDesc);
    return null;
  }

  if (!paymentsConfigured()) {
    console.error("[verity] CDP_API_KEY_NAME / CDP_API_KEY_PRIVATE_KEY missing: refusing paid request");
    res.status(500).json({ error: PAYMENTS_NOT_CONFIGURED });
    return null;
  }

  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(xPaymentHeader, "base64").toString("utf8")) as PaymentPayload;
  } catch {
    send402(res, paymentReqs, bazaarExtension, resourceUrl, resourceDesc, "invalid_payment");
    return null;
  }

  let verifyResult: { isValid: boolean; invalidReason?: string };
  try {
    verifyResult = await facilitatorClient.verify(paymentPayload, paymentReqs);
  } catch (e: any) {
    console.error("[verity] verify error:", e.message);
    res.status(500).json({ error: "Payment verification failed", detail: e.message });
    return null;
  }
  if (!verifyResult.isValid) {
    send402(res, paymentReqs, bazaarExtension, resourceUrl, resourceDesc, verifyResult.invalidReason);
    return null;
  }

  const payment = { header: xPaymentHeader, payload: paymentPayload, reqs: paymentReqs };
  if (!(await claimPayment(res, payment))) return null;
  return payment;
}

// ── One signed payment, one run (same design as AEONOS) ──────────────────────
// Settling after the work leaves a window where the same signed payment could be sent again (or in
// parallel) and get the work done twice. Each payment is claimed in public.payment_claims (primary key)
// before any work starts; a second claim is refused. If the claim can't be recorded, the work doesn't start.
// The id is the payer plus the authorisation's nonce (EIP-3009 `authorization` or Permit2
// `permit2Authorization`): the token contract accepts each payer+nonce once, so this is the payment's real
// identity however the JSON is re-encoded or re-signed. A hash of the raw JSON (the earlier version) could be
// dodged by reordering keys. Payloads without a nonce fall back to a key-sorted hash.
// payment_claims is shared with AEONOS (same database); payer+nonce ids can't collide across the two.
export function paymentId(payload: PaymentPayload): string {
  const p = (payload.payload ?? {}) as Record<string, any>;
  const auth = p.authorization ?? p.permit2Authorization;
  const from = typeof auth?.from === "string" ? auth.from.toLowerCase() : "";
  const nonce = auth?.nonce != null ? String(auth.nonce).toLowerCase() : "";
  const key = from && nonce ? `evm|${from}|${nonce}` : `raw|${canonicalJson(p)}`;
  return createHash("sha256").update(key).digest("hex");
}

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

let claimsDb: SupabaseClient | undefined;

export const PAYMENT_ALREADY_USED_MESSAGE =
  "This payment has already been used for a request. Sign a new payment to run another one. Nothing more was charged.";

// Returns true if this payment is new and now claimed; otherwise sends 409/503 and returns false.
export async function claimPayment(res: VercelResponse, p: PendingPayment): Promise<boolean> {
  if (!p.payload) return true;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error("[verity] payment claim failed: SUPABASE_URL / SUPABASE_SERVICE_KEY missing");
    res.status(503).json({ status: "failed", charged: false, error: NOT_CHARGED_MESSAGE });
    return false;
  }
  claimsDb ??= createClient(url, key);
  let code: string | undefined, message = "";
  try {
    const { error } = await claimsDb.from("payment_claims").insert({ id: paymentId(p.payload) });
    if (!error) return true;
    code = error.code; message = error.message;
  } catch (e: unknown) {
    message = e instanceof Error ? e.message : String(e);
  }
  if (code === "23505") {
    res.status(409).json({ status: "failed", charged: false, error: PAYMENT_ALREADY_USED_MESSAGE });
    return false;
  }
  console.error("[verity] payment claim failed:", message);
  res.status(503).json({ status: "failed", charged: false, error: NOT_CHARGED_MESSAGE });
  return false;
}

export type SettleOutcome =
  | { ok: true; paymentResponse?: string; pendingTx?: string }
  | { ok: false; reason: string };

// The facilitator's non-terminal "settlement_pending" failure (as in @x402/core's x402ResourceServer).
const SETTLEMENT_PENDING = "settlement_pending";
type SettleAttempt = { success: boolean; errorReason?: string; transaction?: string };

async function attemptSettle(p: PendingPayment & { payload: PaymentPayload; reqs: PaymentRequirements }): Promise<SettleAttempt> {
  try {
    return await facilitatorClient.settle(p.payload, p.reqs);
  } catch (e: unknown) {
    // A non-2xx facilitator reply with a settle body arrives as SettleError, carrying reason and tx hash.
    if (e instanceof SettleError) return { success: false, errorReason: e.errorReason, transaction: e.transaction };
    console.error("[verity] settle error:", e instanceof Error ? e.message : String(e));
    return { success: false, errorReason: "settlement_failed" };
  }
}

const isPending = (r: SettleAttempt) => !r.success && r.errorReason === SETTLEMENT_PENDING;

// Takes the money. Call only once the result is ready to send. Internal (PayGated) calls are a no-op.
// - "settlement_pending" with a tx hash: retried once with the identical payload (as x402ResourceServer's
//   settleWithPendingRetry does). Still pending: the buyer has most likely paid, so the result is delivered
//   and Carly is alerted with the tx hash to check on-chain.
// - Any other failure: the route withholds the result; Carly is alerted, since the work was done unpaid.
export async function settlePayment(p: PendingPayment, route: string, caller_id: string): Promise<SettleOutcome> {
  if (!p.payload || !p.reqs) return { ok: true };
  const pay = { ...p, payload: p.payload, reqs: p.reqs };
  let r = await attemptSettle(pay);
  if (isPending(r) && r.transaction) r = await attemptSettle(pay);

  if (r.success) return { ok: true, paymentResponse: Buffer.from(JSON.stringify(r)).toString("base64") };

  if (isPending(r)) {
    const tx = r.transaction || "none reported";
    console.error(`[verity/${route}] settlement still pending after one retry, result delivered. tx:`, tx);
    await alertCarly(
      `VERITY: payment for a ${route} request is still pending (result delivered)`,
      `A paying request to /api/${route} finished the work, but the facilitator still reports the payment as settlement_pending after one retry. The buyer has most likely paid, so the result was delivered.\n\nCaller: ${caller_id}\nTransaction: ${tx}\nTime: ${new Date().toISOString()}\n\nCheck the transaction on basescan.org to confirm it landed.`,
    );
    return { ok: true, pendingTx: tx };
  }

  const reason = r.errorReason || "settlement_failed";
  console.error(`[verity/${route}] settlement failed after the work succeeded, result withheld:`, reason);
  await alertCarly(
    `VERITY: payment for a ${route} request failed to settle (result withheld)`,
    `A paying request to /api/${route} finished the work, but settling the payment failed, so the result was withheld and nothing was charged.\n\nCaller: ${caller_id}\nReason: ${reason}\nTime: ${new Date().toISOString()}\n\nIf this repeats, check the CDP facilitator and the Vercel logs for verity.`,
  );
  return { ok: false, reason };
}

export const NOT_CHARGED_MESSAGE =
  "VERITY could not finish this request, so your payment was not taken. Nothing was charged. Please try again in a few minutes.";

// The work failed before settlement: the buyer keeps their money. Sends a clear message (no raw error)
// and alerts Carly so a run of failures is noticed the same day.
export async function sendNotCharged(res: VercelResponse, route: string, caller_id: string, err: unknown) {
  await alertPaidFailure(route, caller_id, err);
  return res.status(503).json({ status: "failed", charged: false, error: NOT_CHARGED_MESSAGE });
}

export async function alertPaidFailure(route: string, caller_id: string, err: unknown) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[verity/${route}] paid run failed, not charged:`, detail);
  await alertCarly(
    `VERITY: a paid ${route} request failed (buyer not charged)`,
    `A paying request to /api/${route} failed before delivery, so the payment was not taken.\n\nCaller: ${caller_id}\nError: ${detail.slice(0, 500)}\nTime: ${new Date().toISOString()}\n\nIf this repeats, check the Vercel logs for verity.`,
  );
}

// Email (Resend) and Telegram, each sent only if its env vars are set. Never throws.
export async function alertCarly(subject: string, text: string) {
  const key = process.env.RESEND_API_KEY, to = process.env.NOTIFY_EMAIL;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
  await Promise.all([
    key && to && fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: (process.env.RESEND_FROM || "VERITY <noreply@resend.dev>").trim(),
        to: to.trim(),
        subject,
        text,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch((e: unknown) => console.error("[verity] alert email failed:", e instanceof Error ? e.message : String(e))),
    // Log only the error name: a fetch error message could include the bot token from the URL.
    tgToken && tgChat && fetch(`https://api.telegram.org/bot${tgToken.trim()}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: tgChat.trim(), text: `${subject}\n\n${text}`.slice(0, 4000) }),
      signal: AbortSignal.timeout(5_000),
    }).catch((e: unknown) => console.error("[verity] alert Telegram failed:", e instanceof Error ? e.name : "error")),
  ]);
}
