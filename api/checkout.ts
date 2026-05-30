/**
 * GET /api/checkout?pack=starter|standard|pro
 * Creates a Stripe Checkout session, pre-generates a PayGated API key,
 * then redirects the user to pay. After payment PayGated's webhook adds credits.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";

const PACKS: Record<string, { credits: number; amountCents: number; label: string }> = {
  starter:  { credits: 1000,  amountCents: 1000,  label: "VERITY Starter — 1,000 credits ($10)" },
  standard: { credits: 2750,  amountCents: 2500,  label: "VERITY Standard — 2,750 credits ($25)" },
  pro:      { credits: 6000,  amountCents: 5000,  label: "VERITY Pro — 6,000 credits ($50)" },
};

const BASE_URL = "https://verity.basechainlabs.com";

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

  let apiKey: string;
  try {
    const pgRes = await fetch(`${pgUrl}/keys`, {
      method: "POST",
      headers: { "X-Admin-Key": pgAdminKey, "Content-Type": "application/json" },
      body: JSON.stringify({ credits: 1, name: `checkout-${pack}-${Date.now()}` }),
    });
    if (!pgRes.ok) throw new Error(`PayGate error: ${pgRes.status}`);
    const pgData = await pgRes.json() as { key: string };
    apiKey = pgData.key;
  } catch (e: any) {
    console.error("[checkout] PayGate key creation failed:", e.message);
    return res.status(502).json({ error: "Could not initialise payment session. Try again." });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2025-05-28.basil" });

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: { name: selectedPack.label, description: "VERITY credits are consumed per tool call. 1 credit = $0.01 USD." },
        unit_amount: selectedPack.amountCents,
      },
      quantity: 1,
    }],
    mode: "payment",
    customer_creation: "always",
    success_url: `${BASE_URL}/?checkout=success&key=${apiKey}&pack=${pack}`,
    cancel_url:  `${BASE_URL}/#get-access`,
    metadata: {
      agent:            "verity",
      pack,
      paygate_api_key:  apiKey,
      paygate_credits:  String(selectedPack.credits),
    },
  });

  return res.redirect(303, session.url!);
}
