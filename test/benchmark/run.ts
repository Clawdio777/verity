/**
 * VERITY benchmark runner: runs the real verify logic (src/agent.ts) locally on labelled claims.
 * Nothing touches production: caller memory (Supabase) is pointed at a dead local address, and no
 * HTTP route or payment code is involved. Spend is recorded per claim in results/ledger.jsonl and
 * the run stops before the ledger passes the budget (BENCH_BUDGET_USD, default 10).
 *
 *   bun run benchmark --split dev --label baseline [--concurrency 4] [--ids c001,c002] [--smoke]
 *   bun run benchmark --split heldout --label final --final      (held-out: run once)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { score, report, type Claim, type RunResult } from "./score.ts";
import { costOf, recordSpend, totalSpend } from "./ledger.ts";

const arg = (name: string, dflt?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : dflt;
};

async function main() {
  process.env.SUPABASE_URL = "http://127.0.0.1:9"; // caller memory off: never write benchmark traffic to the real table
  process.env.SUPABASE_SERVICE_KEY = "benchmark-no-db";
  const { runAgent } = await import("../../src/agent.ts");

  const here = new URL(".", import.meta.url).pathname;
  const claims = JSON.parse(readFileSync(`${here}claims.json`, "utf8")) as Claim[];
  const split = arg("split", "dev")!;
  const smoke = process.argv.includes("--smoke") ? claims.filter((c) => c.split === "dev" && (c as any).smoke).map((c) => c.id) : null;
  const ids = smoke ?? arg("ids")?.split(",");
  const label = arg("label", "run")!;
  const budget = Number(process.env.BENCH_BUDGET_USD ?? 10);
  const concurrency = Number(arg("concurrency", "4"));
  if (split === "heldout" && !process.argv.includes("--final")) throw new Error("held-out runs need --final (run once)");
  const todo = claims.filter((c) => (ids ? ids.includes(c.id) : split === "all" || c.split === split));

  const results: RunResult[] = [];
  let next = 0;
  let stopped = false;
  const worker = async () => {
    while (next < todo.length && !stopped) {
      const c = todo[next++];
      if (totalSpend() >= budget - 0.15) { stopped = true; console.log(`STOP: ledger at US$${totalSpend().toFixed(2)} of US$${budget}`); return; }
      const t0 = Date.now();
      try {
        const r = await runAgent({ query: `Verify the following claim and return a VerityResult JSON object.\n\nClaim: ${c.claim}`, caller_id: "benchmark" });
        const line = { run: label, claim_id: c.id, ...r.usage };
        recordSpend(line);
        const verdict = r.response.match(/"verdict"\s*:\s*"(CURRENT|OUTDATED|DISPUTED|UNVERIFIABLE)"/)?.[1] ?? null;
        const confidence = Number(r.response.match(/"confidence"\s*:\s*(\d+)/)?.[1] ?? NaN);
        const downgrade = r.response.match(/"downgrade_reason"\s*:\s*"([^"]*)"/)?.[1] ?? null;
        const escalation_rounds = Number(r.response.match(/"escalation_rounds"\s*:\s*(\d+)/)?.[1] ?? 0);
        const seconds = (Date.now() - t0) / 1000;
        results.push({ id: c.id, verdict, seconds, usd: costOf(line), confidence: Number.isFinite(confidence) ? confidence : null, downgrade_reason: downgrade, escalation_rounds, response: r.response, tools: r.tool_calls_made });
        console.log(`${c.id} ${verdict ?? "NO-VERDICT"} (expected ${c.expected}) US$${costOf(line).toFixed(3)} ${seconds.toFixed(0)}s${escalation_rounds ? ` escalated x${escalation_rounds}` : ""}`);
      } catch (e) {
        const name = (e as Error)?.constructor?.name ?? "Error";
        results.push({ id: c.id, verdict: null, error: name, seconds: (Date.now() - t0) / 1000, usd: 0 });
        console.log(`${c.id} ERROR ${name}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));

  mkdirSync(`${here}results`, { recursive: true });
  const name = `${label}-${ids ? "ids" : split}`;
  writeFileSync(`${here}results/${name}.json`, JSON.stringify(results.sort((a, b) => a.id.localeCompare(b.id)), null, 1));
  const md = report(`${label} / ${ids ? "selected ids" : split}`, score(claims, results));
  writeFileSync(`${here}results/${name}.md`, md + "\n");
  console.log("\n" + md + `\n\nLedger total so far: US$${totalSpend().toFixed(3)}`);
}

main().catch((e) => {
  const msg = (e as Error)?.message ?? "";
  console.error("benchmark failed:", (e as Error)?.constructor?.name ?? "Error", msg.startsWith("held-out") ? msg : "");
  process.exit(1);
});
