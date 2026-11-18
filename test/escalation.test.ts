/**
 * Evidence escalation (src/escalation.ts): when the gate would downgrade a verdict for THIN evidence,
 * VERITY searches again (up to 2 rounds) before abstaining, without lowering the bar.
 * Fixed regressions from the 17/11/2026 benchmark: c010 (Taipei 101) and c051 (Merkel) were correct
 * OUTDATED verdicts turned into UNVERIFIABLE after one Wikipedia quote, with no second search.
 * Run: bun test. The Anthropic SDK, the search tools and every page fetch are mocked: nothing is called.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

process.env.ANTHROPIC_API_KEY = "test-anthropic";

let replies: any[] = [];
const sent: any[] = [];
const toolCalls: { name: string; input: any }[] = [];
let toolReply: (name: string, input: any) => string = () => "[]";
let failNextCreateAt = -1;

class FakeAnthropic {
  messages = {
    create: async (req: any) => {
      sent.push(JSON.parse(JSON.stringify(req)));
      if (sent.length === failNextCreateAt) throw new Error("overloaded");
      const r = replies.shift();
      if (!r) throw new Error("test ran out of scripted replies");
      return r;
    },
  };
}
const executeTool = async (name: string, input: any) => { toolCalls.push({ name, input }); return toolReply(name, input); };
mock.module("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }));
mock.module("../src/tools.js", () => ({ tools: [{ name: "searchClaim" }], executeTool }));
mock.module("../src/tools.ts", () => ({ tools: [{ name: "searchClaim" }], executeTool }));

const { runAgent } = await import("../src/agent.ts?escalation");
const { mergeEvidence } = await import("../src/evidence.ts");
const { ESCALATION } = await import("../src/escalation.ts");

const usage = { input_tokens: 10, output_tokens: 5 };
const say = (o: object) => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(o) }], usage });
const callTools = (...calls: { name: string; input: any }[]) => ({
  stop_reason: "tool_use",
  content: calls.map((c, i) => ({ type: "tool_use", id: `t${Math.random().toString(36).slice(2)}${i}`, name: c.name, input: c.input })),
  usage,
});
const search = (query: string, include_domains?: string[]) => ({ name: "searchClaim", input: { query, ...(include_domains ? { include_domains } : {}) } });

// Pages the quote check re-fetches (mocked search results point at these).
const PAGES: Record<string, string> = {
  "https://en.wikipedia.org/wiki/Taipei_101": "Taipei 101 was officially classified as the world's tallest building from its opening in 2004 until the 2009 completion of the Burj Khalifa in Dubai.",
  "https://www.skyscrapercenter.com/building/burj-khalifa/3": "Burj Khalifa has been the tallest building in the world since its completion in 2010, at 828 metres.",
  "https://en.wikipedia.org/wiki/Angela_Merkel": "Angela Merkel is a retired politician who served as chancellor of Germany from 2005 to 2021.",
  "https://www.dw.com/en/merkel-memoir": "Former Chancellor Angela Merkel presented her memoir in Berlin on Tuesday evening.",
  "https://www.bundesregierung.de/breg-en/federal-government/chancellor": "Friedrich Merz has been Federal Chancellor of the Federal Republic of Germany since 6 May 2025.",
  "https://news.example.com/a": "The service is still available to every customer in the region today.",
  "https://www.health.gov.au/b": "The service was withdrawn for all customers on 1 March 2026 by the department.",
};
const fetcher = async (urls: string[]) => new Map(urls.map((u) => [u, PAGES[u] ?? null] as [string, string | null]));
const run = (claim: string) => runAgent({ query: claim, caller_id: "t" }, { fetcher });
const ev = (url: string, quote: string, stance: string) => ({ url, quote, stance });

const WIKI_TAIPEI = ev("https://en.wikipedia.org/wiki/Taipei_101", "Taipei 101 was officially classified as the world's tallest building from its opening in 2004 until the 2009 completion of the Burj Khalifa in Dubai.", "SUPERSEDES");
const CTBUH = ev("https://www.skyscrapercenter.com/building/burj-khalifa/3", "Burj Khalifa has been the tallest building in the world since its completion in 2010", "SUPERSEDES");
const WIKI_MERKEL = ev("https://en.wikipedia.org/wiki/Angela_Merkel", "a retired politician who served as chancellor of Germany from 2005 to 2021", "SUPERSEDES");
const DW_HIST = ev("https://www.dw.com/en/merkel-memoir", "Former Chancellor Angela Merkel presented her memoir in Berlin", "HISTORICAL");
const BREG = ev("https://www.bundesregierung.de/breg-en/federal-government/chancellor", "Friedrich Merz has been Federal Chancellor of the Federal Republic of Germany since 6 May 2025.", "SUPERSEDES");

beforeEach(() => { replies = []; sent.length = 0; toolCalls.length = 0; toolReply = () => "[]"; failNextCreateAt = -1; });

const lastUserText = (req: any) => {
  const m = req.messages[req.messages.length - 1];
  return Array.isArray(m.content) ? m.content.map((b: any) => b.text ?? "").join("\n") : m.content;
};

describe("regression c010: Taipei 101 is the tallest building in the world", () => {
  test("one Wikipedia quote is thin: VERITY searches the authoritative body (CTBUH) and returns OUTDATED", async () => {
    replies = [
      callTools(search("Taipei 101 tallest building in the world")),
      say({ verdict: "OUTDATED", summary: "Burj Khalifa overtook it", what_changed: "Burj Khalifa, 2010", evidence: [WIKI_TAIPEI] }),
      callTools(search("tallest building in the world", ["skyscrapercenter.com"])),
      say({ verdict: "OUTDATED", summary: "Burj Khalifa overtook it", what_changed: "Burj Khalifa, 2010", evidence: [WIKI_TAIPEI, CTBUH] }),
    ];
    const out = JSON.parse((await run("Taipei 101 is the tallest building in the world.")).response);
    expect(out.verdict).toBe("OUTDATED");
    expect(out.confidence).toBe(90); // primary (CTBUH) plus an independent organisation
    expect(out.escalation_rounds).toBe(1);
    expect(out.searched).toBeUndefined();
    expect(out.sources.map((s: any) => s.organisation)).toEqual(["wikipedia.org", "ctbuh.org"]);
    // The escalation turn re-offered the tools and named the authoritative-body route.
    expect(sent[2].tools).toBeDefined();
    const ask = lastUserText(sent[2]);
    expect(ask).toContain("evidence round 1 of 2");
    expect(ask).toContain("found 1 non-primary");
    expect(ask).toContain("skyscrapercenter.com");
    expect(ask).toContain("include_domains");
    expect(toolCalls[1].input.include_domains).toEqual(["skyscrapercenter.com"]);
  });
});

describe("regression c051: Angela Merkel is the Chancellor of Germany", () => {
  test("a HISTORICAL quote does not count; the government's own page settles it as OUTDATED", async () => {
    replies = [
      callTools(search("Angela Merkel Chancellor of Germany")),
      say({ verdict: "OUTDATED", summary: "Merz since 2025", what_changed: "Merz since 6 May 2025", evidence: [WIKI_MERKEL, DW_HIST] }),
      callTools(search("Federal Chancellor Germany", ["bundesregierung.de"])),
      // The model also tries to relabel the DW sentence as SUPERSEDES: that must not count.
      say({ verdict: "OUTDATED", summary: "Merz since 2025", what_changed: "Merz since 6 May 2025", evidence: [WIKI_MERKEL, { ...DW_HIST, stance: "SUPERSEDES" }, BREG] }),
    ];
    const out = JSON.parse((await run("Angela Merkel is the Chancellor of Germany.")).response);
    expect(out.verdict).toBe("OUTDATED");
    expect(out.escalation_rounds).toBe(1);
    expect(out.sources.map((s: any) => s.organisation)).toEqual(["wikipedia.org", "bundesregierung.de"]);
    expect(out.sources.find((s: any) => s.organisation === "bundesregierung.de").primary).toBe(true);
    const ask = lastUserText(sent[2]);
    expect(ask).toContain("Verified but not counted");
    expect(ask).toContain("dw.com");
  });

  test("relabelling the same sentences is not new evidence: after 2 rounds it is UNVERIFIABLE, with what was searched", async () => {
    const relabel = say({ verdict: "OUTDATED", summary: "s", evidence: [WIKI_MERKEL, { ...DW_HIST, stance: "SUPERSEDES" }] });
    replies = [
      callTools(search("Angela Merkel Chancellor of Germany")),
      say({ verdict: "OUTDATED", summary: "s", evidence: [WIKI_MERKEL, DW_HIST] }),
      callTools(search("current chancellor of Germany", ["bundesregierung.de"])),
      relabel,
      callTools(search("Germany chancellor Reuters")),
      relabel,
    ];
    const out = JSON.parse((await run("Angela Merkel is the Chancellor of Germany.")).response);
    expect(out.verdict).toBe("UNVERIFIABLE");
    expect(out.downgraded_from).toBe("OUTDATED");
    expect(out.escalation_rounds).toBe(2);
    expect(out.searched.escalation_rounds).toBe(2);
    expect(out.searched.queries).toEqual([
      "Angela Merkel Chancellor of Germany",
      "current chancellor of Germany [site: bundesregierung.de]",
      "Germany chancellor Reuters",
    ]);
    expect(out.searched.domains).toEqual(expect.arrayContaining(["bundesregierung.de", "en.wikipedia.org", "dw.com"]));
    expect(sent).toHaveLength(6);
  });
});

describe("escalation never lowers the bar or hides a contradiction", () => {
  test("conflicting evidence is DISPUTED straight away: no escalation", async () => {
    replies = [
      callTools(search("q")),
      say({ verdict: "OUTDATED", summary: "s", evidence: [ev("https://www.health.gov.au/b", "The service was withdrawn for all customers on 1 March 2026", "SUPERSEDES"), ev("https://news.example.com/a", "The service is still available to every customer in the region today.", "SUPPORTS")] }),
    ];
    const out = JSON.parse((await run("The service is available.")).response);
    expect(out.verdict).toBe("DISPUTED");
    expect(out.escalation_rounds).toBe(0);
    expect(sent).toHaveLength(2);
  });

  test("a contradiction found while escalating makes the verdict DISPUTED, not CURRENT", async () => {
    replies = [
      callTools(search("q")),
      say({ verdict: "CURRENT", summary: "s", evidence: [ev("https://news.example.com/a", "The service is still available to every customer in the region today.", "SUPPORTS")] }),
      callTools(search("service withdrawn", ["health.gov.au"])),
      say({ verdict: "CURRENT", summary: "s", evidence: [ev("https://www.health.gov.au/b", "The service was withdrawn for all customers on 1 March 2026", "REFUTES")] }),
    ];
    const out = JSON.parse((await run("The service is available.")).response);
    expect(out.verdict).toBe("DISPUTED");
  });

  test("evidence from an earlier round cannot be dropped to pass the gate", () => {
    const a = ev("https://news.example.com/a", "The service is still available to every customer in the region today.", "SUPPORTS") as any;
    const merged = mergeEvidence([a], [{ ...a, quote: "still available to every customer in the region", stance: "SUPERSEDES" }]);
    expect(merged).toEqual([a]);
    expect(mergeEvidence([a], [])).toEqual([a]);
  });

  test("switching between CURRENT and OUTDATED while escalating is UNVERIFIABLE", async () => {
    replies = [
      callTools(search("q")),
      say({ verdict: "CURRENT", summary: "s", evidence: [ev("https://news.example.com/b", "A sentence that is not on any page at all.", "SUPPORTS")] }),
      say({ verdict: "OUTDATED", summary: "s", evidence: [ev("https://www.health.gov.au/b", "The service was withdrawn for all customers on 1 March 2026", "SUPERSEDES")] }),
    ];
    const out = JSON.parse((await run("The service is available.")).response);
    expect(out.verdict).toBe("UNVERIFIABLE");
    expect(out.downgrade_reason).toContain("changed from CURRENT to OUTDATED");
    expect(out.searched).toBeDefined();
  });

  test("no escalation when the search tools failed (nothing to build on)", async () => {
    toolReply = () => "searchClaim error: fetch failed";
    replies = [callTools(search("q")), say({ verdict: "OUTDATED", summary: "s", evidence: [WIKI_TAIPEI] })];
    const out = JSON.parse((await run("Taipei 101 is the tallest building in the world.")).response);
    expect(out.verdict).toBe("UNVERIFIABLE");
    expect(out.escalation_rounds).toBe(0);
    expect(sent).toHaveLength(2);
  });

  test("no escalation when the model itself answers UNVERIFIABLE, or when the verdict already passes", async () => {
    replies = [callTools(search("q")), say({ verdict: "UNVERIFIABLE", summary: "future event", evidence: [] })];
    expect(JSON.parse((await run("It will rain next year.")).response).escalation_rounds).toBe(0);
    expect(sent).toHaveLength(2);
    sent.length = 0;
    replies = [callTools(search("q")), say({ verdict: "OUTDATED", summary: "s", evidence: [WIKI_TAIPEI, CTBUH] })];
    expect(JSON.parse((await run("Taipei 101 is the tallest building in the world.")).response).verdict).toBe("OUTDATED");
    expect(sent).toHaveLength(2);
  });
});

describe("escalation is capped and can never fail a finished check", () => {
  test(`Tavily credits spent by escalation are capped at ${ESCALATION.tavilyCredits}; extra searches are refused`, async () => {
    const advanced = (q: string) => ({ name: "searchClaim", input: { query: q, search_depth: "advanced" } }); // 2 credits each
    replies = [
      callTools(search("q")),
      say({ verdict: "OUTDATED", summary: "s", evidence: [WIKI_TAIPEI] }),
      callTools(advanced("a"), advanced("b"), advanced("c"), advanced("d"), advanced("e"), advanced("f")),
      say({ verdict: "OUTDATED", summary: "s", evidence: [WIKI_TAIPEI] }),
    ];
    const r = await run("Taipei 101 is the tallest building in the world.");
    expect(toolCalls).toHaveLength(1 + ESCALATION.tavilyCredits / 2);
    const refused = sent[3].messages[sent[3].messages.length - 1].content.filter((b: any) => b.is_error);
    expect(refused).toHaveLength(2);
    expect(refused[0].content).toContain("budget");
    // Budget used up: the next turn must answer without tools, and no second round starts.
    expect(sent[3].tools).toBeUndefined();
    expect(JSON.parse(r.response).escalation_rounds).toBe(1);
    expect(r.usage.tavily_credits).toBe(1 + ESCALATION.tavilyCredits);
  });

  test(`each round gets at most ${ESCALATION.turnsPerRound} model turns, the last one without tools`, async () => {
    replies = [
      callTools(search("q")),
      say({ verdict: "OUTDATED", summary: "s", evidence: [WIKI_TAIPEI] }),
      callTools(search("r1")),
      callTools(search("r2")),
      say({ verdict: "OUTDATED", summary: "s", evidence: [WIKI_TAIPEI, CTBUH] }),
    ];
    const out = JSON.parse((await run("Taipei 101 is the tallest building in the world.")).response);
    expect(out.verdict).toBe("OUTDATED");
    expect(sent[3].tools).toBeDefined();
    expect(sent[4].tools).toBeUndefined();
  });

  test("an API error during escalation returns the gated answer from before it instead of failing the run", async () => {
    failNextCreateAt = 3;
    replies = [callTools(search("q")), say({ verdict: "OUTDATED", summary: "s", evidence: [WIKI_TAIPEI] })];
    const out = JSON.parse((await run("Taipei 101 is the tallest building in the world.")).response);
    expect(out.verdict).toBe("UNVERIFIABLE");
    expect(out.escalation_rounds).toBe(1);
    expect(out.searched.queries).toEqual(["q"]);
  });
});
