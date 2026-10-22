/**
 * api/_x402-gate.ts — VERITY shared x402 v2 payment gate
 * Underscore prefix = Vercel does not expose this as a route.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentRequired, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { x402Version as X402_VERSION } from "@x402/core";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension } from "@x402/extensions";

export const facilitatorClient = new HTTPFacilitatorClient(
  process.env.CDP_API_KEY_NAME && process.env.CDP_API_KEY_PRIVATE_KEY
    ? createFacilitatorConfig(
        process.env.CDP_API_KEY_NAME.trim(),
        process.env.CDP_API_KEY_PRIVATE_KEY.trim()
      )
    : {}
);

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
    input: { query: opts.queryExample, caller_id: "my-agent-id" },
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
// If the work fails, sendNotCharged() tells the buyer nothing was taken and emails Carly.
export interface PendingPayment {
  /** Raw payment header, for query_log ("internal-bypass" for PayGated calls). */
  header: string;
  payload?: PaymentPayload;
  reqs?: PaymentRequirements;
}

// Returns the verified (not yet settled) payment, or null if a 402/500 was already sent.
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

  return { header: xPaymentHeader, payload: paymentPayload, reqs: paymentReqs };
}

export type SettleOutcome =
  | { ok: true; paymentResponse?: string }
  | { ok: false; reason: string };

// Takes the money. Call only once the result is ready to send. Internal (PayGated) calls are a no-op.
export async function settlePayment(p: PendingPayment): Promise<SettleOutcome> {
  if (!p.payload || !p.reqs) return { ok: true };
  try {
    const r = await facilitatorClient.settle(p.payload, p.reqs);
    if (!r.success) return { ok: false, reason: r.errorReason || "settlement_failed" };
    return { ok: true, paymentResponse: Buffer.from(JSON.stringify(r)).toString("base64") };
  } catch (e: any) {
    console.error("[verity] settle error:", e.message);
    return { ok: false, reason: "settlement_failed" };
  }
}

export const NOT_CHARGED_MESSAGE =
  "VERITY could not finish this request, so your payment was not taken. Nothing was charged. Please try again in a few minutes.";

// The work failed before settlement: the buyer keeps their money. Sends a clear message (no raw error)
// and emails Carly so a run of failures is noticed the same day.
export async function sendNotCharged(res: VercelResponse, route: string, caller_id: string, err: unknown) {
  await alertPaidFailure(route, caller_id, err);
  return res.status(503).json({ status: "failed", charged: false, error: NOT_CHARGED_MESSAGE });
}

export async function alertPaidFailure(route: string, caller_id: string, err: unknown) {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[verity/${route}] paid run failed, not charged:`, detail);
  const key = process.env.RESEND_API_KEY, to = process.env.NOTIFY_EMAIL;
  if (!key || !to) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: (process.env.RESEND_FROM || "VERITY <noreply@resend.dev>").trim(),
        to: to.trim(),
        subject: `VERITY: a paid ${route} request failed (buyer not charged)`,
        text: `A paying request to /api/${route} failed before delivery, so the payment was not taken.\n\nCaller: ${caller_id}\nError: ${detail.slice(0, 500)}\nTime: ${new Date().toISOString()}\n\nIf this repeats, check the Vercel logs for verity.`,
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (e: any) {
    console.error("[verity] failure alert email failed:", e.message);
  }
}
