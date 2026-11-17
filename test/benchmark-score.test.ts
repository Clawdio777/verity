/**
 * Offline checks for the benchmark (free, safe for CI): the claims file is well formed and the scorer
 * counts wrong-confident and abstain rates the way the report says. The live run is `bun run benchmark`.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { score, type Claim } from "./benchmark/score.ts";

const claims = JSON.parse(readFileSync(new URL("./benchmark/claims.json", import.meta.url), "utf8")) as (Claim & { group?: string | null; smoke?: boolean })[];

test("100 labelled claims, unique ids, 60 dev / 40 held-out", () => {
  expect(claims).toHaveLength(100);
  expect(new Set(claims.map((c) => c.id)).size).toBe(100);
  expect(claims.filter((c) => c.split === "dev")).toHaveLength(60);
  expect(claims.filter((c) => c.split === "heldout")).toHaveLength(40);
});

test("every label is one of the four verdicts, is accepted, and has a reason", () => {
  for (const c of claims) {
    expect(["CURRENT", "OUTDATED", "DISPUTED", "UNVERIFIABLE"]).toContain(c.expected);
    expect(c.accept).toContain(c.expected);
    expect(c.reason.length).toBeGreaterThan(5);
  }
});

test("every CURRENT/OUTDATED/DISPUTED label has a source URL and a quoted sentence", () => {
  for (const c of claims.filter((c) => c.expected !== "UNVERIFIABLE")) {
    expect(c.source_url).toMatch(/^https:\/\//);
    expect(c.source_quote.length).toBeGreaterThanOrEqual(20);
  }
});

test("paired claims (same group) sit in the same split, so held-out never sees a twin from dev", () => {
  const groups = new Map<string, Set<string>>();
  for (const c of claims) if (c.group) groups.set(c.group, (groups.get(c.group) ?? new Set()).add(c.split));
  for (const splits of groups.values()) expect(splits.size).toBe(1);
});

test("smoke subset is five dev claims", () => {
  const smoke = claims.filter((c) => c.smoke);
  expect(smoke).toHaveLength(5);
  expect(smoke.every((c) => c.split === "dev")).toBe(true);
});

test("scorer: wrong-confident rate counts only CURRENT/OUTDATED, abstain counts UNVERIFIABLE on answerable claims", () => {
  const cs: Claim[] = [
    { id: "a", split: "dev", category: "true", claim: "", expected: "CURRENT", accept: ["CURRENT"], reason: "", source_url: "", source_quote: "" },
    { id: "b", split: "dev", category: "false", claim: "", expected: "DISPUTED", accept: ["DISPUTED", "UNVERIFIABLE"], reason: "", source_url: "", source_quote: "" },
    { id: "c", split: "dev", category: "outdated", claim: "", expected: "OUTDATED", accept: ["OUTDATED"], reason: "", source_url: "", source_quote: "" },
    { id: "d", split: "dev", category: "unverifiable", claim: "", expected: "UNVERIFIABLE", accept: ["UNVERIFIABLE"], reason: "", source_url: "", source_quote: "" },
  ];
  const s = score(cs, [
    { id: "a", verdict: "CURRENT", seconds: 1, usd: 0.1 },
    { id: "b", verdict: "CURRENT", seconds: 1, usd: 0.1 }, // confidently wrong
    { id: "c", verdict: "UNVERIFIABLE", seconds: 1, usd: 0.1 }, // abstained
    { id: "d", verdict: null, error: "APIError", seconds: 1, usd: 0 },
  ]);
  expect(s.confident_verdicts).toBe(2);
  expect(s.wrong_confident).toBe(1);
  expect(s.wrong_confident_rate).toBe(0.5);
  expect(s.abstain_rate).toBe(0.25);
  expect(s.run_failures).toBe(1);
  expect(s.per_verdict.CURRENT.precision).toBe(0.5);
});
