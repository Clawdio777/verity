/**
 * GET /api/recover-key?email=xxx
 * Looks up VERITY PayGated API keys for the given email via Stripe:
 * 1. Find customer by email
 * 2. List their paid checkout sessions
 * 3. Return paygate_api_key from metadata
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

const STRIPE_ACCT    = "acct_1THZO7KGSHr8O3LS";
const STRIPE_VERSION = "2025-02-24.acacia";
const AGENT          = "verity";

async function stripeGet(path: string, key: string): Promise<any> {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: {
      "Authorization":  `Bearer ${key}`,
      "Stripe-Context": STRIPE_ACCT,
      "Stripe-Version": STRIPE_VERSION,
    },
  });
  return res.json();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).end();

  const email = ((req.query.email as string) || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Valid email required." });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return res.status(503).json({ error: "Not configured." });

  try {
    // Step 1: find Stripe customer(s) for this email
    const custData = await stripeGet(
      `/v1/customers?email=${encodeURIComponent(email)}&limit=10`,
      stripeKey
    );
    const customers: any[] = custData.data || [];

    // Step 2: collect paid sessions across all matching customers
    const keys: { key: string; pack: string; credits: string; date: string }[] = [];

    for (const cust of customers) {
      const sessData = await stripeGet(
        `/v1/checkout/sessions?customer=${cust.id}&payment_status=paid&limit=20`,
        stripeKey
      );
      const sessions: any[] = sessData.data || [];
      for (const s of sessions) {
        const meta = s.metadata ?? {};
        if (meta.paygate_api_key && meta.agent === AGENT) {
          keys.push({
            key:     meta.paygate_api_key,
            pack:    meta.pack || "",
            credits: meta.paygate_credits || "",
            date:    new Date(s.created * 1000).toLocaleDateString("en-AU"),
          });
        }
      }
    }

    if (keys.length === 0) {
      return res.status(404).json({ error: "No purchases found for that email." });
    }

    return res.status(200).json({ keys });
  } catch (e: any) {
    console.error("[recover-key] error:", e.message);
    return res.status(500).json({ error: "Something went wrong. Try again." });
  }
}
