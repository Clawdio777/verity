/**
 * no_memory: true means the agent loop neither reads nor writes caller memory for that call, so no
 * remembered context is ever passed off as a fresh check. Run: bun test. SDK and tools are mocked.
 */
import { beforeEach, expect, mock, test } from "bun:test";

process.env.ANTHROPIC_API_KEY = "test-anthropic";

let replies: any[] = [];
const sent: any[] = [];
const executed: string[] = [];
class FakeAnthropic {
  messages = { create: async (req: any) => { sent.push(JSON.parse(JSON.stringify(req))); return replies.shift(); } };
}
const toolList = [{ name: "searchClaim" }, { name: "retrieveCallerMemory" }, { name: "storeCallerMemory" }];
const executeTool = async (name: string) => { executed.push(name); return "ok"; };
mock.module("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }));
mock.module("../src/tools.js", () => ({ tools: toolList, executeTool }));
mock.module("../src/tools.ts", () => ({ tools: toolList, executeTool }));

const { runAgent } = await import("../src/agent.ts?no-memory");

const usage = { input_tokens: 10, output_tokens: 5 };
const fetcher = async (urls: string[]) => new Map(urls.map((u) => [u, null] as [string, string | null]));
const memoryCalls = {
  stop_reason: "tool_use", usage,
  content: [
    { type: "tool_use", id: "m1", name: "retrieveCallerMemory", input: { caller_id: "c" } },
    { type: "tool_use", id: "m2", name: "storeCallerMemory", input: { caller_id: "c", updates: { topics: ["x"] } } },
  ],
};
const answer = { stop_reason: "end_turn", usage, content: [{ type: "text", text: '{"verdict":"UNVERIFIABLE","summary":"s"}' }] };

beforeEach(() => { replies = []; sent.length = 0; executed.length = 0; });

test("no_memory: memory tools are not offered, the model is told, and a memory call anyway is refused without running", async () => {
  replies = [memoryCalls, answer];
  await runAgent({ query: "claim", caller_id: "c", no_memory: true }, { fetcher });
  expect(sent[0].tools.map((t: any) => t.name)).toEqual(["searchClaim"]);
  expect(sent[0].messages[0].content).toContain("Caller memory: OFF");
  expect(executed).toEqual([]);
  const results = sent[1].messages[2].content;
  expect(results.every((r: any) => r.is_error && r.content.includes("memory is off"))).toBe(true);
});

test("without the flag, memory works as before", async () => {
  replies = [memoryCalls, answer];
  await runAgent({ query: "claim", caller_id: "c" }, { fetcher });
  expect(sent[0].tools.map((t: any) => t.name)).toEqual(["searchClaim", "retrieveCallerMemory", "storeCallerMemory"]);
  expect(sent[0].messages[0].content).not.toContain("Caller memory: OFF");
  expect(executed).toEqual(["retrieveCallerMemory", "storeCallerMemory"]);
});
