/** Scoring for the VERITY benchmark. Pure functions: no network, unit-tested in test/benchmark-score.test.ts. */

export interface Claim {
  id: string; split: "dev" | "heldout"; category: string; claim: string;
  expected: string; accept: string[]; reason: string; source_url: string; source_quote: string;
}

export interface RunResult {
  id: string; verdict: string | null; error?: string; seconds: number; usd: number;
  confidence?: number | null; downgrade_reason?: string | null; response?: string; tools?: string[];
}

const CONFIDENT = ["CURRENT", "OUTDATED"];
const VERDICTS = ["CURRENT", "OUTDATED", "DISPUTED", "UNVERIFIABLE"];

export function score(claims: Claim[], results: RunResult[]) {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const rows = results.filter((r) => byId.has(r.id)).map((r) => {
    const c = byId.get(r.id)!;
    const correct = r.verdict !== null && c.accept.includes(r.verdict);
    return { ...r, expected: c.expected, category: c.category, correct, confident: r.verdict !== null && CONFIDENT.includes(r.verdict) };
  });
  const n = rows.length;
  const done = rows.filter((r) => r.verdict !== null);
  const perVerdict = Object.fromEntries(VERDICTS.map((v) => {
    const said = done.filter((r) => r.verdict === v);
    const right = said.filter((r) => r.correct).length;
    return [v, { said: said.length, right, precision: said.length ? right / said.length : null }];
  }));
  const confident = done.filter((r) => r.confident);
  const wrongConfident = confident.filter((r) => !r.correct);
  const abstained = done.filter((r) => r.verdict === "UNVERIFIABLE" && r.expected !== "UNVERIFIABLE");
  const secs = done.map((r) => r.seconds).sort((a, b) => a - b);
  const usd = rows.reduce((s, r) => s + r.usd, 0);
  return {
    claims: n,
    run_failures: n - done.length,
    correct: done.filter((r) => r.correct).length,
    accuracy: n ? done.filter((r) => r.correct).length / n : 0,
    per_verdict: perVerdict,
    confident_verdicts: confident.length,
    wrong_confident: wrongConfident.length,
    wrong_confident_rate: confident.length ? wrongConfident.length / confident.length : 0,
    abstain_rate: n ? abstained.length / n : 0,
    unverifiable_share: n ? done.filter((r) => r.verdict === "UNVERIFIABLE").length / n : 0,
    usd_total: usd,
    usd_per_claim: n ? usd / n : 0,
    seconds_median: secs.length ? secs[Math.floor(secs.length / 2)] : 0,
    seconds_max: secs.length ? secs[secs.length - 1] : 0,
    wrong: rows.filter((r) => !r.correct).map((r) => ({ id: r.id, expected: r.expected, got: r.verdict ?? `ERROR ${r.error}`, confident: r.confident })),
  };
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);

export function report(title: string, s: ReturnType<typeof score>): string {
  return [
    `## ${title}`,
    ``,
    `Claims: ${s.claims} | run failures: ${s.run_failures} | correct: ${s.correct} (${pct(s.accuracy)})`,
    `CURRENT/OUTDATED verdicts: ${s.confident_verdicts} | wrong: ${s.wrong_confident} | wrong-confident rate: ${pct(s.wrong_confident_rate)}`,
    `Abstain rate (UNVERIFIABLE on a claim with a known answer): ${pct(s.abstain_rate)} | UNVERIFIABLE share overall: ${pct(s.unverifiable_share)}`,
    `Cost: US$${s.usd_total.toFixed(3)} total, US$${s.usd_per_claim.toFixed(4)} per claim | time: median ${s.seconds_median.toFixed(0)}s, max ${s.seconds_max.toFixed(0)}s`,
    ``,
    `| Verdict | said | right | precision |`,
    `|---|---|---|---|`,
    ...Object.entries(s.per_verdict).map(([v, p]) => `| ${v} | ${p.said} | ${p.right} | ${pct(p.precision)} |`),
    ``,
    `Wrong: ${s.wrong.length ? s.wrong.map((w) => `${w.id} expected ${w.expected} got ${w.got}${w.confident ? " (CONFIDENT)" : ""}`).join("; ") : "none"}`,
  ].join("\n");
}
