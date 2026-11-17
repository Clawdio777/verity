/**
 * runAgent must ask once for the verdict when a run ends without one (23/10/2026: 1 in 10 paid checks
 * ended with "No response produced" after the research was done), and must tell the model today's date.
 * Run: bun test. The Anthropic SDK and the tools are mocked: nothing is called.
 */
import { beforeEach, expect, mock, test } from "bun:test";

process.env.ANTHROPIC_API_KEY = "test-anthropic";

let replies: any[] = [];
let toolReply = "ok";
const sent: any[] = [];
class FakeAnthropic {
  messages = {
    create: async (req: any) => {
      sent.push(JSON.parse(JSON.stringify(req)));
      return replies.shift();
    },
  };
}
mock.module("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }));
mock.module("../src/tools.js", () => ({ tools: [], executeTool: async () => toolReply }));
mock.module("../src/tools.ts", () => ({ tools: [], executeTool: async () => toolReply }));

// Other test files replace ../src/agent.ts with a stub; the query string loads the real module.
const { runAgent } = await import("../src/agent.ts?real");

const usage = { input_tokens: 10, output_tokens: 5 };
const PAGE_URL = "https://www.health.gov.au/plan";
const PAGE = "From 1 July 2025 the plan was renamed the GP Chronic Condition Management Plan.";
const VERDICT = JSON.stringify({ verdict: "OUTDATED", confidence: 99, summary: "renamed", what_changed: "renamed 1 July 2025",
  evidence: [{ url: PAGE_URL, quote: "the plan was renamed the GP Chronic Condition Management Plan", stance: "SUPERSEDES" }] });
// Quotes are re-checked against this in-memory page instead of the live web.
const fetcher = async (urls: string[]) => new Map(urls.map((u) => [u, u === PAGE_URL ? PAGE : null] as [string, string | null]));
const run = () => runAgent({ query: "claim", caller_id: "t" }, { fetcher });

beforeEach(() => { replies = []; sent.length = 0; toolReply = "ok"; });

test("a run that ends empty gets one more turn and returns the verdict", async () => {
  replies = [
    { stop_reason: "end_turn", content: [], usage },
    { stop_reason: "end_turn", content: [{ type: "text", text: VERDICT }], usage },
  ];
  const r = await run();
  // A verdict comes back; with no search done at all it cannot be a confident one.
  expect(JSON.parse(r.response).verdict).toBe("UNVERIFIABLE");
  expect(JSON.parse(r.response).downgraded_from).toBe("OUTDATED");
  expect(sent).toHaveLength(2);
  expect(sent[1].tools).toBeUndefined();
});

test("prose without a verdict gets one more turn", async () => {
  replies = [
    { stop_reason: "end_turn", content: [{ type: "text", text: "I have enough information now." }], usage },
    { stop_reason: "end_turn", content: [{ type: "text", text: VERDICT }], usage },
  ];
  const r = await run();
  expect(r.response).toContain('"verdict"');
});

test("the verdict is found when it follows a short text block", async () => {
  replies = [{ stop_reason: "end_turn", content: [{ type: "text", text: "Done." }, { type: "text", text: VERDICT }], usage }];
  const r = await run();
  expect(r.response).toContain('"OUTDATED"');
  expect(sent).toHaveLength(1);
});

test("still no verdict after the extra turn: the run fails, so nobody is charged", async () => {
  replies = [
    { stop_reason: "end_turn", content: [], usage },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Sorry." }], usage },
  ];
  await expect(run()).rejects.toThrow("No response produced");
});

test("the model is told today's date and runs on Sonnet 5.5", async () => {
  replies = [{ stop_reason: "end_turn", content: [{ type: "text", text: VERDICT }], usage }];
  await run();
  expect(sent[0].messages[0].content).toContain(`Today's date: ${new Date().toISOString().slice(0, 10)}`);
  expect(sent[0].model).toBe("claude-sonnet-5-5");
});

const toolTurn = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "searchClaim", input: { query: "q" } }], usage };

test("the verdict that comes back is gated by code: verified quote, derived confidence, sources = verified evidence", async () => {
  replies = [toolTurn, { stop_reason: "end_turn", content: [{ type: "text", text: VERDICT }], usage }];
  const out = JSON.parse((await run()).response);
  expect(out.verdict).toBe("OUTDATED");
  expect(out.confidence).toBe(80); // primary (.gov.au) source; the model's 99 is ignored
  expect(out.sources).toHaveLength(1);
  expect(out.sources[0].quote).toContain("renamed");
});

test("when every search tool fails, the run returns UNVERIFIABLE instead of the model's answer from memory", async () => {
  toolReply = "searchClaim error: fetch failed";
  replies = [toolTurn, { stop_reason: "end_turn", content: [{ type: "text", text: VERDICT }], usage }];
  const out = JSON.parse((await run()).response);
  expect(out.verdict).toBe("UNVERIFIABLE");
  expect(out.downgrade_reason).toContain("tools failed");
  // and the failed tool result was flagged to the model as an error
  expect(sent[1].messages[2].content[0].is_error).toBe(true);
});

test("a quote that is not on its page turns OUTDATED into UNVERIFIABLE", async () => {
  const bad = VERDICT.replace("the plan was renamed the GP Chronic Condition Management Plan", "the plan was abolished entirely in 2024 by the minister");
  replies = [toolTurn, { stop_reason: "end_turn", content: [{ type: "text", text: bad }], usage }];
  const out = JSON.parse((await run()).response);
  expect(out.verdict).toBe("UNVERIFIABLE");
  expect(out.downgraded_from).toBe("OUTDATED");
});
