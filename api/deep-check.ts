/**
 * POST /api/deep-check — VERITY thorough multi-angle verification
 *
 * Uses advanced Tavily search depth, 5+ angles, cross-references authoritative sources.
 * Higher confidence output for high-stakes fact-checks. 0.50 USDC per call.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requirePayment, buildPaymentReqs, buildBazaarExtension, send402 } from "./_x402-gate.js";
import { runAgent } from "../src/agent.js";

const PRICE_USDC    = 0.50;
const BASE_URL      = () => (process.env.AGENT_BASE_URL || "https://verity.basechainlabs.com").trim();
const RESOURCE_URL  = () => `${BASE_URL()}/api/deep-check`;
const RESOURCE_DESC = "Deep multi-angle claim verification. 5+ search angles, advanced Tavily depth, cross-referenced sources. Higher confidence result for high-stakes checks. 0.50 USDC.";

const BAZAAR = buildBazaarExtension({
  serviceName:      "VERITY — Deep Fact Check",
  queryDescription: "The claim to deeply verify across multiple angles and authoritative sources",
  queryExample:     "Deep check: Is climate change causing more frequent Category 5 hurricanes?",
  outputExample:    '{"verdict":"DISPUTED","confidence":58,"summary":"Scientific consensus confirms increased intensity but frequency data is debated.","sources":[...],"what_changed":"Two major studies in 2025 reached conflicting conclusions on frequency trends."}',
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
    const directive = `Perform a THOROUGH multi-angle deep verification of the following claim.
Use search_depth: "advanced" for searchClaim calls.
Search at least 3 different angle queries to get comprehensive coverage.
Cross-reference all sources before forming your verdict.
Return a VerityResult JSON object with high-confidence analysis.

Claim: ${claim}`;

    const result = await runAgent({ query: directive, caller_id });

    await db.schema("verity").from("verification_log").insert({
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
