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
    maxTimeoutSeconds: 300,
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

export async function requirePayment(
  req: VercelRequest,
  res: VercelResponse,
  priceUsdc: number,
  bazaarExtension: Record<string, unknown>,
  resourceUrl: string,
  resourceDesc: string
): Promise<string | null> {
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

  let settleResult: { success: boolean; errorReason?: string; transaction?: string; network?: string };
  try {
    settleResult = await facilitatorClient.settle(paymentPayload, paymentReqs);
  } catch (e: any) {
    console.error("[verity] settle error:", e.message);
    res.status(500).json({ error: "Payment settlement failed", detail: e.message });
    return null;
  }
  if (!settleResult.success) {
    send402(res, paymentReqs, bazaarExtension, resourceUrl, resourceDesc, settleResult.errorReason);
    return null;
  }

  res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settleResult)).toString("base64"));
  return xPaymentHeader;
}
