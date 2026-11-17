/**
 * Live check of the benchmark labels: fetches every claim's source_url and confirms its
 * source_quote is on the page (same normaliser VERITY uses). Prints only pass/fail and, for a
 * failure, the sentences around the first words of the quote. Run: bun test/benchmark/check-sources.ts [file] [--context]
 */
import { readFileSync } from "node:fs";
import { defaultFetcher, normaliseText, quoteOnPage } from "../../src/evidence.ts";
import { recordSpend } from "./ledger.ts";

try {
  const file = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : new URL("./claims.json", import.meta.url).pathname;
  const showContext = process.argv.includes("--context");
  const claims = JSON.parse(readFileSync(file, "utf8")) as { id?: string; claim: string; source_url: string; source_quote: string }[];
  const withSource = claims.filter((c) => c.source_url);
  const wanted = new Map<string, string[]>();
  for (const c of withSource) wanted.set(c.source_url, [...(wanted.get(c.source_url) ?? []), c.source_quote]);
  const stats = { tavily_credits: 0 };
  const pages = await defaultFetcher(stats, wanted)([...wanted.keys()]);
  let bad = 0;
  for (const [i, c] of withSource.entries()) {
    const page = pages.get(c.source_url);
    const ok = !!page && quoteOnPage(c.source_quote, page);
    if (!ok) bad++;
    console.log(`${ok ? "OK  " : "MISS"} ${c.id ?? i} ${c.source_url}${page ? "" : " (page not fetched)"}`);
    if (showContext && page) {
      const text = normaliseText(page);
      const key = normaliseText(c.source_quote).split(" ").slice(0, 4).join(" ");
      let at = text.indexOf(key), n = 0;
      while (at >= 0 && n < 3) { console.log(`     …${text.slice(Math.max(0, at - 200), at + 250)}…`); at = text.indexOf(key, at + 1); n++; }
    }
  }
  recordSpend({ run: "check-sources", tavily_credits: stats.tavily_credits });
  console.log(`\n${withSource.length - bad}/${withSource.length} quotes found live; Tavily credits used: ${stats.tavily_credits}`);
} catch (e) {
  console.error("check-sources failed:", (e as Error)?.constructor?.name ?? "Error");
  process.exit(1);
}
