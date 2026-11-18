/**
 * The npm package (mcp-server.mjs) pays with card credits when VERITY_API_KEY is set: it forwards tools/list and
 * tools/call to the hosted /api/mcp with the pg_ key in X-Api-Key (18/11/2026: it used to ignore the key the
 * purchase email told buyers to set). Runs the real package under node; fetch is stubbed, nothing leaves the machine.
 */
import { expect, test } from "bun:test";

const SERVER = new URL("../mcp-server.mjs", import.meta.url).pathname;
const STUB   = new URL("./fixtures/hosted-stub.mjs", import.meta.url).pathname;
const FAKE_KEY = "pg_" + "0".repeat(48);

async function run(env: Record<string, string>, requests: object[]) {
  const proc = Bun.spawn(["node", "--import", STUB, SERVER], {
    env: { PATH: process.env.PATH!, ...env },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  proc.stdin.write(requests.map(r => JSON.stringify(r)).join("\n") + "\n");
  await proc.stdin.flush();
  await Bun.sleep(1500);
  proc.kill();
  const out = (await new Response(proc.stdout).text()).trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  const stubbed = (await new Response(proc.stderr).text()).split("\n").filter(l => l.startsWith("STUB ")).map(l => JSON.parse(l.slice(5)));
  return { out, stubbed };
}

const call = { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "verity_verify", arguments: { claim: "Paris is the capital of France" } } };

test("VERITY_API_KEY set: the call goes to the hosted endpoint with X-Api-Key, and its error comes back with our id", async () => {
  const { out, stubbed } = await run({ VERITY_API_KEY: FAKE_KEY }, [call]);
  expect(stubbed).toHaveLength(1);
  expect(stubbed[0].url).toBe("https://verity.basechainlabs.com/api/mcp");
  expect(stubbed[0].apiKey).toBe(FAKE_KEY);
  expect(stubbed[0].body).toEqual(call);
  expect(out).toEqual([{ jsonrpc: "2.0", id: 7, error: { code: -32402, message: "Payment required: Invalid API key." } }]);
}, 10_000);

test("VERITY_API_KEY unset: no network call, the not-configured message names both options", async () => {
  const { out, stubbed } = await run({}, [call]);
  expect(stubbed).toHaveLength(0);
  expect(out[0].id).toBe(7);
  expect(out[0].result.content[0].text).toContain("VERITY_API_KEY");
  expect(out[0].result.content[0].text).toContain("VERITY_PRIVATE_KEY");
}, 10_000);
