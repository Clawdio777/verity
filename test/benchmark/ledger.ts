/** Spend ledger for live benchmark runs: one JSON line per paid call batch, so the budget cap holds across runs. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

// Sonnet 5.5 list prices (US$ per million tokens) and Tavily pay-as-you-go (US$ per credit).
export const PRICE = { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5, tavily_credit: 0.008 };

const DIR = new URL("./results/", import.meta.url).pathname;
const FILE = `${DIR}ledger.jsonl`;

export interface SpendLine {
  run: string; claim_id?: string;
  input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
  tavily_credits?: number;
}

export function costOf(l: SpendLine): number {
  return ((l.input_tokens ?? 0) * PRICE.input + (l.output_tokens ?? 0) * PRICE.output +
    (l.cache_read_input_tokens ?? 0) * PRICE.cache_read + (l.cache_creation_input_tokens ?? 0) * PRICE.cache_write) / 1e6 +
    (l.tavily_credits ?? 0) * PRICE.tavily_credit;
}

export function recordSpend(l: SpendLine) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  appendFileSync(FILE, JSON.stringify({ ...l, at: new Date().toISOString(), usd: Number(costOf(l).toFixed(5)) }) + "\n");
}

export function totalSpend(): number {
  if (!existsSync(FILE)) return 0;
  return readFileSync(FILE, "utf8").split("\n").filter(Boolean).reduce((s, l) => s + (JSON.parse(l).usd ?? 0), 0);
}
