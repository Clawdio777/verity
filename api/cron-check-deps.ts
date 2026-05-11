/**
 * api/cron-check-deps.ts — VERITY weekly x402 dependency checker
 * Vercel cron: Sunday 11pm UTC (9am AEST Monday). Emails if major/minor bumps detected.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

const PACKAGES = [
  { name: "@x402/core",        pinned: "2.11.0" },
  { name: "@x402/evm",         pinned: "2.11.0" },
  { name: "@x402/extensions",  pinned: "2.11.0" },
  { name: "@x402/fetch",       pinned: "2.11.0" },
  { name: "@coinbase/x402",    pinned: "2.1.0"  },
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const results: { name: string; pinned: string; latest: string; bump: string | null }[] = [];

  for (const pkg of PACKAGES) {
    try {
      const r = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`);
      const data = await r.json() as { version: string };
      const latest = data.version;
      const bump = detectBump(pkg.pinned, latest);
      results.push({ name: pkg.name, pinned: pkg.pinned, latest, bump });
    } catch {
      results.push({ name: pkg.name, pinned: pkg.pinned, latest: "unknown", bump: null });
    }
  }

  const upgrades = results.filter(r => r.bump === "major" || r.bump === "minor");

  if (upgrades.length > 0) {
    const rows = upgrades.map(r => `<tr><td>${r.name}</td><td>${r.pinned}</td><td><strong>${r.latest}</strong></td><td style="color:orange">${r.bump?.toUpperCase()}</td></tr>`).join("");
    const html = `<h3>VERITY — x402 Dependency Updates</h3><table border="1" cellpadding="6"><tr><th>Package</th><th>Pinned</th><th>Latest</th><th>Bump</th></tr>${rows}</table><p>Update package.json and test before deploying.</p>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "VERITY <noreply@basechainlabs.com>",
        to: process.env.NOTIFY_EMAIL || "clawdio777@gmail.com",
        subject: `⚠️ VERITY — ${upgrades.length} x402 package update${upgrades.length > 1 ? "s" : ""} available`,
        html,
      }),
    });
  }

  return res.json({ ok: true, results, upgrades_found: upgrades.length });
}

function detectBump(pinned: string, latest: string): string | null {
  const [pMaj, pMin] = pinned.split(".").map(Number);
  const [lMaj, lMin] = latest.split(".").map(Number);
  if (lMaj > pMaj) return "major";
  if (lMin > pMin) return "minor";
  return null;
}
