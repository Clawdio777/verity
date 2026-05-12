/**
 * POST /api/mcp — VERITY MCP HTTP endpoint (Streamable HTTP transport)
 * For Smithery and other MCP clients. Wallet key via X-Wallet-Key header.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createWalletClient, createPublicClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";

const BASE_URL = "https://verity.basechainlabs.com";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    content: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", const: "text" },
          text: { type: "string", description: "VerityResult JSON with verdict, confidence, sources, and what changed" },
        },
        required: ["type", "text"],
      },
    },
  },
  required: ["content"],
};

const TOOL_ANNOTATIONS = {
  readOnlyHint:    true,
  destructiveHint: false,
  idempotentHint:  false,
  openWorldHint:   true,
};

const TOOLS = [
  {
    name:        "verity_verify",
    description: "Verify a claim, URL, or statement against live web sources. Returns CURRENT/OUTDATED/DISPUTED/UNVERIFIABLE verdict, confidence 0–100, sources, and what has changed. 0.10 USDC per call.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {
        claim:     { type: "string", description: "The claim, URL, or content to verify. E.g. 'Is GPT-4 still the most capable AI model?' or 'https://example.com/article'" },
        caller_id: { type: "string", description: "Optional stable ID to activate persistent memory across calls." },
      },
      required: ["claim"],
    },
    outputSchema: OUTPUT_SCHEMA,
  },
  {
    name:        "verity_deep_check",
    description: "Thorough multi-angle verification with advanced search depth. Cross-references 5+ angles and authoritative sources. Higher confidence result for high-stakes fact-checks. 0.50 USDC per call.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {
        claim:     { type: "string", description: "The claim to deeply verify. E.g. 'Did the 2024 US election results change after court challenges?'" },
        caller_id: { type: "string", description: "Optional stable ID for persistent memory." },
      },
      required: ["claim"],
    },
    outputSchema: OUTPUT_SCHEMA,
  },
  {
    name:        "verity_batch",
    description: "Verify up to 10 claims in one call. Returns an array of verdicts. Use for content audits and fact-check pipelines. 0.75 USDC for the batch.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {
        claims:    { type: "array", items: { type: "string" }, description: "Array of claims to verify. Max 10." },
        caller_id: { type: "string", description: "Optional stable ID for persistent memory." },
      },
      required: ["claims"],
    },
    outputSchema: OUTPUT_SCHEMA,
  },
  {
    name:        "verity_agent",
    description: "Natural language fact-checking. Ask anything: 'Is this still true?', 'When was this last updated?', 'Check this URL'. VERITY selects the right strategy automatically. 0.10 USDC per call.",
    annotations: TOOL_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: {
        query:     { type: "string", description: "Natural language fact-check request. E.g. 'Is Elon Musk still the richest person in the world?'" },
        caller_id: { type: "string", description: "Optional stable ID for persistent memory." },
      },
      required: ["query"],
    },
    outputSchema: OUTPUT_SCHEMA,
  },
];

const TOOL_ROUTES: Record<string, { path: string; field: string }> = {
  verity_verify:     { path: "/api/verify",       field: "claim" },
  verity_deep_check: { path: "/api/deep-check",   field: "claim" },
  verity_batch:      { path: "/api/batch-verify", field: "claims" },
  verity_agent:      { path: "/api/agent",         field: "query" },
};

function buildX402Fetch(privateKey: string) {
  const account      = privateKeyToAccount(privateKey as `0x${string}`);
  const transport    = viemHttp("https://mainnet.base.org");
  const walletClient = createWalletClient({ account, chain: base, transport });
  const publicClient = createPublicClient({ chain: base, transport });
  const signer       = toClientEvmSigner(
    { address: account.address, signTypedData: (m: any) => walletClient.signTypedData(m), readContract: (a: any) => publicClient.readContract(a) },
    publicClient
  );
  const evmScheme = new ExactEvmScheme(signer);
  const client    = x402Client.fromConfig({ schemes: [{ x402Version: 2, network: "eip155:8453", client: evmScheme }] });
  return wrapFetchWithPayment(fetch, client);
}

async function callVerity(path: string, body: Record<string, any>, privateKey: string): Promise<string> {
  const x402Fetch = buildX402Fetch(privateKey);
  const res = await x402Fetch(`${BASE_URL}${path}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`VERITY error: HTTP ${res.status} — ${await res.text()}`);
  const data = await res.json() as any;
  return data?.artifact?.parts?.[0]?.text ?? JSON.stringify(data);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Wallet-Key, X-Caller-Id");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const privateKey = (req.headers["verity_private_key"] ?? req.headers["x-wallet-key"] ?? process.env.MCP_DEMO_PRIVATE_KEY) as string | undefined;
  const defaultCallerId = req.headers["x-caller-id"] as string | undefined;

  const body = req.body as { jsonrpc: string; id: any; method: string; params?: any };
  const { id, method, params } = body;

  if (method === "initialize") {
    return res.json({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo:      { name: "verity", version: "1.0.0" },
        capabilities:    { tools: {}, prompts: {} },
        instructions: `You have access to VERITY — a specialist real-time fact-checking and data freshness agent.

Use VERITY tools to verify claims, URLs, and content against live web sources before trusting or publishing them.

Tool selection guide:
- Quick claim check → verity_verify (0.10 USDC)
- High-stakes or complex claim → verity_deep_check (0.50 USDC)
- Auditing a piece of content with multiple claims → verity_batch (0.75 USDC)
- Natural language question → verity_agent (0.10 USDC)

VERITY returns structured verdicts: CURRENT, OUTDATED, DISPUTED, or UNVERIFIABLE — with confidence 0–100, sources, and exactly what has changed.

Pass a consistent caller_id to activate persistent memory. VERITY remembers domains and topics you've checked before.

Payments via x402 (USDC on Base). Each call deducts from the configured wallet.`,
      },
    });
  }

  if (method === "notifications/initialized") return res.status(204).end();
  if (method === "resources/list") return res.json({ jsonrpc: "2.0", id, result: { resources: [] } });

  if (method === "prompts/list") {
    return res.json({
      jsonrpc: "2.0", id,
      result: {
        prompts: [
          { name: "verify-claim",   description: "Verify a specific claim against live sources",                       arguments: [{ name: "claim", description: "The claim to verify", required: true }] },
          { name: "check-url",      description: "Check if a URL's content is still current and accurate",             arguments: [{ name: "url", description: "URL to check", required: true }] },
          { name: "content-audit",  description: "Audit a piece of content for outdated claims",                       arguments: [{ name: "content", description: "Content to audit", required: true }] },
          { name: "deep-verify",    description: "Thorough multi-angle verification for high-stakes fact-checks",      arguments: [{ name: "claim", description: "The claim to deeply verify", required: true }] },
          { name: "freshness-check",description: "Check how fresh/current a topic or data point is",                  arguments: [{ name: "topic", description: "Topic or data point to check", required: true }] },
        ],
      },
    });
  }

  if (method === "prompts/get") {
    const { name, arguments: args } = params as { name: string; arguments: Record<string, string> };
    const PROMPT_MESSAGES: Record<string, string> = {
      "verify-claim":    `Verify this claim and return a verdict with confidence score, sources, and what has changed: ${args?.claim}`,
      "check-url":       `Check if this URL's content is still current and accurate. Fetch the page, find the publication date, and search for newer information on the same topic: ${args?.url}`,
      "content-audit":   `Audit the following content for outdated or disputed claims. Identify each claim, verify it, and flag which ones are OUTDATED or DISPUTED with sources:\n\n${args?.content}`,
      "deep-verify":     `Perform a thorough multi-angle deep verification of this claim. Use advanced search, check 5+ angles, cross-reference authoritative sources, and return a high-confidence verdict: ${args?.claim}`,
      "freshness-check": `How current and accurate is the following topic or data point? When was it last updated, what has changed recently, and what is the current state as of today? Topic: ${args?.topic}`,
    };

    const text = PROMPT_MESSAGES[name];
    if (!text) return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown prompt: ${name}` } });

    return res.json({
      jsonrpc: "2.0", id,
      result: { description: `VERITY — ${name}`, messages: [{ role: "user", content: { type: "text", text } }] },
    });
  }

  if (method === "tools/list") return res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });

  if (method === "tools/call") {
    const { name, arguments: args } = params as { name: string; arguments: Record<string, any> };
    const route = TOOL_ROUTES[name];

    if (!route) return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } });

    if (!privateKey) {
      return res.json({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: "⚠️ **Wallet key not configured.**\n\nTo use VERITY, configure a Base wallet private key with USDC in the connection settings (X-Wallet-Key header).\n\nGet USDC on Base at coinbase.com/wallet." }] },
      });
    }

    try {
      const reqBody: Record<string, any> = {
        [route.field]: args[route.field] ?? args.claim ?? args.query,
        caller_id: args.caller_id || defaultCallerId || "mcp-user",
      };
      const text = await callVerity(route.path, reqBody, privateKey);
      return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (e: any) {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message } });
    }
  }

  return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}
