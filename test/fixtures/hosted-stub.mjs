// Preloaded with `node --import` by test/npm-api-key.test.ts: replaces fetch so the package never reaches the
// network. Each request is written to stderr as one "STUB {...}" line; the reply is the hosted -32402 error.
globalThis.fetch = async (url, init = {}) => {
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  process.stderr.write("STUB " + JSON.stringify({ url: String(url), apiKey: headers["x-api-key"] ?? null, body: JSON.parse(init.body ?? "null") }) + "\n");
  const body = { jsonrpc: "2.0", id: "hosted-id", error: { code: -32402, message: "Payment required: Invalid API key." } };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};
