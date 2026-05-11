/**
 * POST /api/verify — VERITY standard fact-check
 *
 * Takes a claim, URL, or statement and verifies it against live web sources.
 * Returns: verdict (CURRENT/OUTDATED/DISPUTED/UNVERIFIABLE), confidence 0–100,
 * sources, and what has changed. 0.10 USDC per call.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requirePayment, buildPaymentReqs, buildBazaarExtension, send402 } from "./_x402-gate.js";
import { runAgent } from "../src/agent.js";

const PRICE_USDC    = 0.10;
const BASE_URL      = () => process.env.AGENT_BASE_URL || "https://verity.basechainlabs.com";
const RESOURCE_URL  = () => `${BASE_URL()}/api/verify`;
const RESOURCE_DESC = "Real-time claim verification. Returns CURRENT/OUTDATED/DISPUTED/UNVERIFIABLE verdict with confidence score, sources, and what changed. 0.10 USDC.";

const BAZAAR = buildBazaarExtension({
  serviceName:      "VERITY — Claim Verification",
  queryDescription: "The claim, URL, or content to verify. E.g. 'Is OpenAI still valued at $157B?' or 'https://example.com/article'",
  queryExample:     "Verify: Is GPT-4 still the most capable OpenAI model?",
  outputExample:    '{"verdict":"OUTDATED","confidence":91,"summary":"GPT-4 has been superseded by GPT-4o and o3 models as of 2025.","what_changed":"OpenAI released GPT-4o in May 2024 and o3 in late 2024, both outperforming GPT-4.","sources":[{"url":"https://openai.com/blog/...","title":"...","published_date":"2025-01","supports":"CONTRADICTS"}]}',
});

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Payment-Signature, X-Payment, Accept");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET" || (req.method === "POST" && !req.body?.query && !req.body?.claim)) {
    return send402(res, buildPaymentReqs(PRICE_USDC), BAZAAR, RESOURCE_URL(), RESOURCE_DESC);
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const claim     = req.body?.claim || req.body?.query || "";
  const caller_id = req.body?.caller_id || "anon";

  const paymentHeader = await requirePayment(req, res, PRICE_USDC, BAZAAR, RESOURCE_URL(), RESOURCE_DESC);
  if (paymentHeader === null) return;

  try {
    const directive = `Verify the following claim and return a VerityResult JSON object.\n\nClaim: ${claim}`;
    const result    = await runAgent({ query: directive, caller_id });

    await db.from("verification_log").insert({
      caller_id,
      claim,
      verdict: extractVerdict(result.response),
      confidence: extractConfidence(result.response),
      sources_found: countSources(result.response),
      url_checked: claim.startsWith("http"),
      response_tokens: result.tokens_used,
      payment_usdc: PRICE_USDC,
    });

    return res.json({
      status:   "completed",
      artifact: { parts: [{ type: "text", text: result.response }], index: 0 },
      tokens:   result.tokens_used,
    });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
}

function extractVerdict(response: string): string {
  const match = response.match(/"verdict"\s*:\s*"(CURRENT|OUTDATED|DISPUTED|UNVERIFIABLE)"/);
  return match?.[1] ?? "UNVERIFIABLE";
}

function extractConfidence(response: string): number {
  const match = response.match(/"confidence"\s*:\s*(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function countSources(response: string): number {
  return (response.match(/"url"\s*:/g) || []).length;
}
