/**
 * POST /api/stripe-webhook
 * Receives Stripe checkout.session.completed events.
 * Adds credits to the pre-generated PayGated API key and emails it to the customer.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { Resend } from "resend";

export const config = { api: { bodyParser: false } };

async function getRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end",   () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const stripeKey      = process.env.STRIPE_SECRET_KEY!;
  const webhookSecret  = process.env.STRIPE_WEBHOOK_SECRET!;
  const pgUrl          = process.env.PAYGATE_VERITY_URL!;
  const pgAdminKey     = process.env.PAYGATE_VERITY_ADMIN_KEY!;

  const stripe = new Stripe(stripeKey, { apiVersion: "2025-02-24.acacia" });
  const rawBody = await getRawBody(req);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"] as string, webhookSecret);
  } catch (e: any) {
    console.error("[stripe-webhook] signature verification failed:", e.message);
    return res.status(400).json({ error: "Invalid signature" });
  }

  if (event.type !== "checkout.session.completed") return res.status(200).json({ received: true });

  const session  = event.data.object as Stripe.Checkout.Session;
  const meta     = session.metadata ?? {};
  const apiKey   = meta.paygate_api_key;
  const credits  = parseInt(meta.paygate_credits ?? "0", 10);
  const email    = session.customer_details?.email ?? "";

  if (!apiKey || !credits) {
    console.error("[stripe-webhook] missing metadata", meta);
    return res.status(200).json({ received: true });
  }

  try {
    const pgRes = await fetch(`${pgUrl}/topup`, {
      method:  "POST",
      headers: { "X-Admin-Key": pgAdminKey, "Content-Type": "application/json" },
      body:    JSON.stringify({ key: apiKey, credits }),
    });
    if (!pgRes.ok) throw new Error(`PayGate credits error: ${pgRes.status} — ${await pgRes.text()}`);
  } catch (e: any) {
    console.error("[stripe-webhook] failed to add credits:", e.message);
    return res.status(500).json({ error: "Failed to add credits" });
  }

  if (email) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from:    "VERITY <onboarding@resend.dev>",
        to:      email,
        subject: "Your VERITY API Key",
        html: `
<p>Thanks for your purchase. Here is your VERITY API key:</p>
<p style="font-family:monospace;font-size:16px;background:#f4f4f4;padding:12px;border-radius:6px;">${apiKey}</p>
<p><strong>Credits added:</strong> ${credits.toLocaleString()} (${credits / 100} USD value)</p>
<h3>How to use in Claude Desktop</h3>
<pre style="background:#1a1a1a;color:#30d158;padding:12px;border-radius:6px;">
{
  "mcpServers": {
    "verity": {
      "command": "npx",
      "args": ["verity-mcp"],
      "env": {
        "VERITY_API_KEY": "${apiKey}"
      }
    }
  }
}
</pre>
<p>Or use the PayGated MCP endpoint directly:<br>
<code>https://verity-paygate.up.railway.app/mcp</code><br>
Header: <code>X-Api-Key: ${apiKey}</code></p>
<p style="color:#888;font-size:13px;">Credits consumed per call: verity_verify 10cr · verity_deep_check 50cr · verity_batch 75cr · verity_agent 10cr</p>
        `.trim(),
      });
    } catch (e: any) {
      console.error("[stripe-webhook] email failed:", e.message);
    }
  }

  console.log(`[stripe-webhook] ✓ ${credits} credits added to ${apiKey} for ${email}`);
  return res.status(200).json({ received: true });
}
