/**
 * GET /api/checkout?pack=starter|standard|pro
 * Creates a Stripe Checkout session via raw fetch (handles sk_org_live_ keys with Stripe-Context header),
 * pre-generates a PayGated API key, then redirects to Stripe.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

const PACKS: Record<string, { credits: number; amountCents: number; label: string }> = {
  starter:  { credits: 1000,  amountCents: 1000,  label: "VERITY Starter — 1,000 credits ($10)" },
  standard: { credits: 2750,  amountCents: 2500,  label: "VERITY Standard — 2,750 credits ($25)" },
  pro:      { credits: 6000,  amountCents: 5000,  label: "VERITY Pro — 6,000 credits ($50)" },
};

const BASE_URL     = "https://verity.basechainlabs.com";
const STRIPE_ACCT  = "acct_1THZO7KGSHr8O3LS";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const pack = (req.query.pack as string) || "starter";
  const selectedPack = PACKS[pack] ?? PACKS.starter;

  const stripeKey  = process.env.STRIPE_SECRET_KEY;
  const pgUrl      = process.env.PAYGATE_VERITY_URL;
  const pgAdminKey = process.env.PAYGATE_VERITY_ADMIN_KEY;

  if (!stripeKey || !pgUrl || !pgAdminKey) {
    return res.status(503).json({ error: "Card payments not yet configured. Use x402 (USDC on Base) instead." });
  }

  // Pre-generate a PayGated API key (1 credit placeholder; credits added by webhook after payment)
  let apiKey: string;
  try {
    const pgRes = await fetch(`${pgUrl}/keys`, {
      method: "POST",
      headers: { "X-Admin-Key": pgAdminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ credits: 1, name: `checkout-${pack}-${Date.now()}` }),
    });
    if (!pgRes.ok) throw new Error(`PayGate error: ${pgRes.status} — ${await pgRes.text()}`);
    const pgData = await pgRes.json() as { key: string };
    apiKey = pgData.key;
  } catch (e: any) {
    console.error("[checkout] PayGate key creation failed:", e.message);
    return res.status(502).json({ error: "Could not initialise payment session. Try again." });
  }

  // Create Stripe Checkout Session via raw fetch (required for sk_org_live_ keys)
  const body = new URLSearchParams({
    "payment_method_types[0]":                           "card",
    "line_items[0][price_data][currency]":               "usd",
    "line_items[0][price_data][product_data][name]":     selectedPack.label,
    "line_items[0][price_data][product_data][description]": "VERITY credits are consumed per tool call. 1 credit = $0.01 USD.",
    "line_items[0][price_data][unit_amount]":            String(selectedPack.amountCents),
    "line_items[0][quantity]":                           "1",
    "mode":                                              "payment",
    "customer_creation":                                 "always",
    "success_url":                                       `${BASE_URL}/?checkout=success&key=${apiKey}&pack=${pack}`,
    "cancel_url":                                        `${BASE_URL}/#get-access`,
    "metadata[agent]":                                   "verity",
    "metadata[pack]":                                    pack,
    "metadata[paygate_api_key]":                         apiKey,
    "metadata[paygate_credits]":                         String(selectedPack.credits),
  });

  let sessionUrl: string;
  try {
    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization":  `Bearer ${stripeKey}`,
        "Stripe-Context": STRIPE_ACCT,
        "Stripe-Version": "2025-02-24.acacia",
        "Content-Type":   "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const stripeData = await stripeRes.json() as any;
    if (!stripeRes.ok) {
      console.error("[checkout] Stripe error:", JSON.stringify(stripeData.error));
      return res.status(502).json({ error: "Could not create checkout session. Try again." });
    }
    sessionUrl = stripeData.url;
  } catch (e: any) {
    console.error("[checkout] Stripe fetch failed:", e.message);
    return res.status(502).json({ error: "Could not create checkout session. Try again." });
  }

  return res.redirect(303, sessionUrl);
}
