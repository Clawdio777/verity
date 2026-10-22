/**
 * runAgent must ask once for the verdict when a run ends without one (23/10/2026: 1 in 10 paid checks
 * ended with "No response produced" after the research was done), and must tell the model today's date.
 * Run: bun test. The Anthropic SDK and the tools are mocked: nothing is called.
 */
import { beforeEach, expect, mock, test } from "bun:test";

process.env.ANTHROPIC_API_KEY = "test-anthropic";

let replies: any[] = [];
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
mock.module("../src/tools.js", () => ({ tools: [], executeTool: async () => "ok" }));
mock.module("../src/tools.ts", () => ({ tools: [], executeTool: async () => "ok" }));

// Other test files replace ../src/agent.ts with a stub; the query string loads the real module.
const { runAgent } = await import("../src/agent.ts?real");

const usage = { input_tokens: 10, output_tokens: 5 };
const VERDICT = '{"verdict":"OUTDATED","confidence":80,"summary":"renamed"}';

beforeEach(() => { replies = []; sent.length = 0; });

test("a run that ends empty gets one more turn and returns the verdict", async () => {
  replies = [
    { stop_reason: "end_turn", content: [], usage },
    { stop_reason: "end_turn", content: [{ type: "text", text: VERDICT }], usage },
  ];
  const r = await runAgent({ query: "claim", caller_id: "t" });
  expect(r.response).toContain('"OUTDATED"');
  expect(sent).toHaveLength(2);
  expect(sent[1].tools).toBeUndefined();
});

test("prose without a verdict gets one more turn", async () => {
  replies = [
    { stop_reason: "end_turn", content: [{ type: "text", text: "I have enough information now." }], usage },
    { stop_reason: "end_turn", content: [{ type: "text", text: VERDICT }], usage },
  ];
  const r = await runAgent({ query: "claim", caller_id: "t" });
  expect(r.response).toContain('"verdict"');
});

test("the verdict is found when it follows a short text block", async () => {
  replies = [{ stop_reason: "end_turn", content: [{ type: "text", text: "Done." }, { type: "text", text: VERDICT }], usage }];
  const r = await runAgent({ query: "claim", caller_id: "t" });
  expect(r.response).toContain('"OUTDATED"');
  expect(sent).toHaveLength(1);
});

test("still no verdict after the extra turn: the run fails, so nobody is charged", async () => {
  replies = [
    { stop_reason: "end_turn", content: [], usage },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Sorry." }], usage },
  ];
  await expect(runAgent({ query: "claim", caller_id: "t" })).rejects.toThrow("No response produced");
});

test("the model is told today's date and runs on Sonnet 5.5", async () => {
  replies = [{ stop_reason: "end_turn", content: [{ type: "text", text: VERDICT }], usage }];
  await runAgent({ query: "claim", caller_id: "t" });
  expect(sent[0].messages[0].content).toContain(`Today's date: ${new Date().toISOString().slice(0, 10)}`);
  expect(sent[0].model).toBe("claude-sonnet-5-5");
});
