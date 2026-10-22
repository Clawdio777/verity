/**
 * The hosted MCP endpoint must never accept a buyer's wallet private key (22/10/2026, Base/Coinbase docs review).
 * Run: bun test. Every network call throws, and the agent is mocked, so nothing paid can run.
 */
import { expect, mock, test } from "bun:test";

Object.assign(process.env, {
  SUPABASE_URL: "http://localhost:1", SUPABASE_SERVICE_KEY: "test-service", ANTHROPIC_API_KEY: "test-anthropic",
  MCP_DEMO_PRIVATE_KEY: "0x" + "1".repeat(64), // even if a demo key were set, it must not be used
});

let agentRuns = 0;
const runAgent = async () => { agentRuns++; return { response: "ran", tool_calls_made: [], tokens_used: 1, costs: {}, cost_usd: 0 }; };
mock.module("../src/agent.ts", () => ({ runAgent }));
mock.module("../src/agent.js", () => ({ runAgent }));

const fetched: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  fetched.push(String(input instanceof Request ? input.url : input));
  throw new Error("no network in tests");
}) as typeof fetch;

const { default: mcp } = await import("../api/mcp.ts");

function fakeRes() {
  const r: any = { statusCode: 200, body: undefined as any, headers: {} as Record<string, string> };
  r.setHeader = (k: string, v: string) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

test("a wallet private key in a header is ignored: no payment is signed and no work runs", async () => {
  const res = fakeRes();
  await mcp({
    method: "POST",
    query: {},
    headers: {
      "content-type": "application/json",
      "x-wallet-key": "0x" + "2".repeat(64),
      "verity_private_key": "0x" + "3".repeat(64),
    },
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "verity_verify", arguments: { claim: "The Eiffel Tower is in Paris" } } },
  } as any, res);
  const text = JSON.stringify(res.body);
  expect(text).toContain("Payment not configured");
  expect(text).toContain("npx verity-mcp");
  expect(agentRuns).toBe(0);
  expect(fetched).toHaveLength(0);
  expect(res.headers["access-control-allow-headers"]).not.toMatch(/private-key|wallet-key/i);
});
