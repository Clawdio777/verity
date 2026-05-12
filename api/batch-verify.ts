/**
 * POST /api/batch-verify — VERITY bulk claim verification
 *
 * Verify up to 10 claims in one call. Returns an array of VerityResult objects.
 * 0.75 USDC for the batch (discount vs 10x individual calls).
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requirePayment, buildPaymentReqs, buildBazaarExtension, send402 } from "./_x402-gate.js";
import { runAgent } from "../src/agent.js";

const PRICE_USDC    = 0.75;
const BASE_URL      = () => (process.env.AGENT_BASE_URL || "https://verity.basechainlabs.com").trim();
const RESOURCE_URL  = () => `${BASE_URL()}/api/batch-verify`;
const RESOURCE_DESC = "Batch fact-checking with persistent memory — verify up to 10 claims per call. VERITY remembers prior checks so repeat claims aren't re-verified. Use for content audits and fact-check pipelines. 0.75 USDC for the batch.";

const BAZAAR = buildBazaarExtension({
  serviceName:      "VERITY — Batch Verify",
  queryDescription: "JSON array of up to 10 claims to verify, or a newline-separated list",
  queryExample:     '["GPT-4 is OpenAIs most capable model", "The iPhone 15 was released in 2024", "Python is the most popular programming language"]',
  outputExample:    '[{"claim":"...","verdict":"OUTDATED","confidence":88},{"claim":"...","verdict":"CURRENT","confidence":75}]',
});

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Payment-Signature, X-Payment, Accept");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET" || (req.method === "POST" && !req.body?.claims && !req.body?.query)) {
    return send402(res, buildPaymentReqs(PRICE_USDC), BAZAAR, RESOURCE_URL(), RESOURCE_DESC);
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Accept claims as array, or as a string (newline-separated)
  let claims: string[] = [];
  if (Array.isArray(req.body?.claims)) {
    claims = req.body.claims.slice(0, 10);
  } else if (typeof req.body?.query === "string") {
    // Try to parse as JSON array first
    try {
      const parsed = JSON.parse(req.body.query);
      if (Array.isArray(parsed)) claims = parsed.slice(0, 10);
    } catch {
      claims = req.body.query.split("\n").map((c: string) => c.trim()).filter(Boolean).slice(0, 10);
    }
  }

  if (!claims.length) return res.status(400).json({ error: "Provide claims as array or newline-separated string. Max 10." });

  const caller_id = req.body?.caller_id || "anon";

  const paymentHeader = await requirePayment(req, res, PRICE_USDC, BAZAAR, RESOURCE_URL(), RESOURCE_DESC);
  if (paymentHeader === null) return;

  try {
    // Run all claims concurrently
    const results = await Promise.all(
      claims.map(async (claim) => {
        const directive = `Verify this claim and return a compact VerityResult JSON. Keep summary to 1 sentence.\n\nClaim: ${claim}`;
        const result    = await runAgent({ query: directive, caller_id });
        return { claim, result: result.response, tokens: result.tokens_used };
      })
    );

    const totalTokens = results.reduce((sum, r) => sum + r.tokens, 0);

    // Log each as a separate verification
    await Promise.all(
      results.map(r =>
        db.schema("verity").from("verification_log").insert({
          caller_id,
          claim: r.claim,
          verdict: extractVerdict(r.result),
          confidence: extractConfidence(r.result),
          sources_found: countSources(r.result),
          url_checked: false,
          response_tokens: r.tokens,
          payment_usdc: PRICE_USDC / claims.length,
        })
      )
    );

    return res.json({
      status:   "completed",
      count:    results.length,
      artifact: {
        parts: [{ type: "text", text: JSON.stringify(results.map(r => ({ claim: r.claim, result: r.result })), null, 2) }],
        index: 0,
      },
      tokens: totalTokens,
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
