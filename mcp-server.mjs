#!/usr/bin/env node
/**
 * VERITY MCP Server — stdio transport
 *
 * Usage:
 *   VERITY_PRIVATE_KEY=0x... node mcp-server.mjs
 *
 * Or via npx:
 *   npx verity-mcp
 *
 * Claude Desktop config:
 *   { "command": "npx", "args": ["verity-mcp"], "env": { "VERITY_PRIVATE_KEY": "0x..." } }
 */

import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

const BASE_URL    = "https://verity.basechainlabs.com";
const PRIVATE_KEY = process.env.VERITY_PRIVATE_KEY;

function buildX402Fetch() {
  if (!PRIVATE_KEY) return null;
  const account      = privateKeyToAccount(PRIVATE_KEY);
  const transport    = http("https://mainnet.base.org");
  const walletClient = createWalletClient({ account, chain: base, transport });
  const publicClient = createPublicClient({ chain: base, transport });
  const signer = toClientEvmSigner(
    { address: account.address, signTypedData: m => walletClient.signTypedData(m), readContract: a => publicClient.readContract(a) },
    publicClient
  );
  const evmScheme = new ExactEvmScheme(signer);
  const client    = x402Client.fromConfig({ schemes: [{ x402Version: 2, network: "eip155:8453", client: evmScheme }] });
  return wrapFetchWithPayment(fetch, client);
}

const x402Fetch = buildX402Fetch();

async function callVerity(path, body) {
  if (!x402Fetch) return "⚠️ VERITY_PRIVATE_KEY not configured. Add a Base wallet private key with USDC to use VERITY tools.";
  const res = await x402Fetch(`${BASE_URL}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`VERITY error: HTTP ${res.status}`);
  const data = await res.json();
  return data?.artifact?.parts?.[0]?.text ?? JSON.stringify(data);
}

const TOOLS = [
  {
    name:        "verity_verify",
    description: "Verify a claim, URL, or statement against live web sources. Returns CURRENT/OUTDATED/DISPUTED/UNVERIFIABLE verdict, confidence 0–100, sources, and what has changed. 0.10 USDC per call.",
    inputSchema: {
      type: "object",
      properties: {
        claim:     { type: "string", description: "The claim, URL, or content to verify." },
        caller_id: { type: "string", description: "Optional stable ID for persistent memory." },
      },
      required: ["claim"],
    },
  },
  {
    name:        "verity_deep_check",
    description: "Thorough multi-angle verification. Uses advanced search depth and cross-references authoritative sources. For high-stakes fact-checks. 0.50 USDC per call.",
    inputSchema: {
      type: "object",
      properties: {
        claim:     { type: "string", description: "The claim to deeply verify." },
        caller_id: { type: "string", description: "Optional stable ID for persistent memory." },
      },
      required: ["claim"],
    },
  },
  {
    name:        "verity_batch",
    description: "Verify up to 10 claims in one call. Returns array of verdicts. 0.75 USDC for the batch.",
    inputSchema: {
      type: "object",
      properties: {
        claims:    { type: "array", items: { type: "string" }, description: "Array of claims to verify. Max 10." },
        caller_id: { type: "string", description: "Optional stable ID for persistent memory." },
      },
      required: ["claims"],
    },
  },
  {
    name:        "verity_agent",
    description: "Natural language fact-checking. 'Is this still true?', 'Check this URL', 'When was this last updated?' — VERITY picks the right strategy. 0.10 USDC per call.",
    inputSchema: {
      type: "object",
      properties: {
        query:     { type: "string", description: "Natural language fact-check request." },
        caller_id: { type: "string", description: "Optional stable ID for persistent memory." },
      },
      required: ["query"],
    },
  },
];

const TOOL_ROUTES = {
  verity_verify:     { path: "/api/verify",       field: "claim"  },
  verity_deep_check: { path: "/api/deep-check",   field: "claim"  },
  verity_batch:      { path: "/api/batch-verify", field: "claims" },
  verity_agent:      { path: "/api/agent",         field: "query"  },
};

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

async function handleRequest(req) {
  const { id, method, params } = req;

  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      serverInfo:      { name: "verity", version: "1.0.0" },
      capabilities:    { tools: {} },
    }});
  }

  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });

  if (method === "tools/call") {
    const { name, arguments: args } = params;
    const route = TOOL_ROUTES[name];
    if (!route) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } });

    try {
      const body = {
        [route.field]: args[route.field] ?? args.claim ?? args.query,
        caller_id: args.caller_id || "mcp-user",
      };
      const text = await callVerity(route.path, body);
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message } });
    }
  }

  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { handleRequest(JSON.parse(line)); }
    catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  }
});
