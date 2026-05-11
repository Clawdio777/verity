/**
 * api/daily-summary.ts — VERITY daily summary email
 * Vercel cron: 11pm UTC (9am AEST). Requires CRON_SECRET, RESEND_API_KEY, NOTIFY_EMAIL.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const now = new Date();
  const yesterdayStart = new Date(now);
  yesterdayStart.setUTCDate(now.getUTCDate() - 1);
  yesterdayStart.setUTCHours(0, 0, 0, 0);
  const yesterdayEnd = new Date(now);
  yesterdayEnd.setUTCHours(0, 0, 0, 0);

  const { data: rows, error } = await db
    .from("verification_log")
    .select("caller_id, payment_usdc, verdict, created_at")
    .gte("created_at", yesterdayStart.toISOString())
    .lt("created_at", yesterdayEnd.toISOString());

  if (error) return res.status(500).json({ error: error.message });

  const totalChecks    = rows?.length ?? 0;
  const paidRows       = rows?.filter(r => Number(r.payment_usdc) > 0) ?? [];
  const totalUSDC      = paidRows.reduce((sum, r) => sum + Number(r.payment_usdc), 0);
  const uniqueCallers  = new Set(rows?.map(r => r.caller_id)).size;

  const verdictCounts = (rows || []).reduce((acc: Record<string, number>, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});

  const melbDate = new Date(yesterdayStart.getTime() + 10 * 60 * 60 * 1000);
  const dateLabel = melbDate.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const subject = totalUSDC > 0
    ? `💰 VERITY — $${totalUSDC.toFixed(2)} USDC earned ${dateLabel}`
    : `VERITY — ${totalChecks} check${totalChecks === 1 ? "" : "s"} on ${dateLabel}`;

  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #111;">
      <h2 style="margin-bottom: 4px;">VERITY Daily Summary</h2>
      <p style="color: #666; margin-top: 0;">${dateLabel}</p>
      <hr style="border: none; border-top: 1px solid #eee;" />
      <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
        <tr><td style="padding: 8px 0; color: #666;">Total checks</td><td style="padding: 8px 0; text-align: right; font-weight: 600;">${totalChecks}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Unique callers</td><td style="padding: 8px 0; text-align: right; font-weight: 600;">${uniqueCallers}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Paid checks</td><td style="padding: 8px 0; text-align: right; font-weight: 600;">${paidRows.length}</td></tr>
        ${Object.entries(verdictCounts).map(([v, c]) => `<tr><td style="padding: 4px 0; color: #666; padding-left: 16px;">— ${v}</td><td style="padding: 4px 0; text-align: right;">${c}</td></tr>`).join("")}
        <tr style="border-top: 2px solid #111;"><td style="padding: 12px 0; font-weight: 700; font-size: 18px;">Total earned</td><td style="padding: 12px 0; text-align: right; font-weight: 700; font-size: 18px; color: #16a34a;">$${totalUSDC.toFixed(2)} USDC</td></tr>
      </table>
      ${totalChecks === 0 ? `<p style="color: #999; font-size: 14px;">No activity yesterday — VERITY is live and waiting.</p>` : ""}
      <hr style="border: none; border-top: 1px solid #eee;" />
      <p style="color: #aaa; font-size: 12px; margin: 0;">VERITY · <a href="https://verity.basechainlabs.com" style="color: #aaa;">verity.basechainlabs.com</a></p>
    </div>
  `;

  if (!process.env.NOTIFY_EMAIL) return res.status(500).json({ error: "NOTIFY_EMAIL not set" });

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: process.env.RESEND_FROM || "VERITY <noreply@basechainlabs.com>", to: process.env.NOTIFY_EMAIL, subject, html }),
  });

  if (!resendRes.ok) return res.status(500).json({ error: "Email send failed", detail: await resendRes.text() });

  return res.json({ ok: true, subject, totalChecks, paidChecks: paidRows.length, totalUSDC });
}
