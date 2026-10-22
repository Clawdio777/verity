/**
 * POST /api/mcp — VERITY MCP HTTP endpoint (Streamable HTTP transport)
 * For Smithery and other MCP clients. Paid through PayGate credits (pg_token). The hosted endpoint never
 * accepts a wallet private key (removed 22/10/2026: the x402 docs keep the buyer's key on the buyer's
 * machine). Wallet (USDC) buyers use the local stdio server `npx verity-mcp` (mcp-server.mjs).
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { runAgent } from "../src/agent.js";


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
    description: "Verify a claim, URL, or statement against multiple live sources: web search (Tavily), AI synthesis (Perplexity), Wikipedia, and academic papers (Semantic Scholar). Returns CURRENT/OUTDATED/DISPUTED/UNVERIFIABLE verdict, confidence 0–100, sources with credibility tiers, and what has changed. 0.10 USDC per call. Supports agent-to-agent trust workflows — verify another agent's stated capabilities or track record before task delegation. Use this to detect AI hallucinations, misinformation, and outdated facts before publishing.",
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
    description: "Thorough multi-angle verification using all available sources: Perplexity sonar-pro, Wikipedia, Semantic Scholar academic papers, and advanced Tavily search. Cross-references 5+ independent angles. Returns highest-confidence verdicts for high-stakes fact-checks. 0.50 USDC per call.",
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

function buildVerityDirective(toolName: string, args: Record<string, any>): string {
  switch (toolName) {
    case "verity_verify":
      return `Verify the following claim and return a VerityResult JSON object.\n\nClaim: ${args.claim}`;
    case "verity_deep_check":
      return `Perform a THOROUGH multi-angle deep verification of the following claim. Use advanced search depth, check 5+ angles, cross-reference authoritative sources including Wikipedia and academic papers, and return a high-confidence verdict with detailed sourcing.\n\nClaim: ${args.claim}`;
    case "verity_batch": {
      const claims: string[] = Array.isArray(args.claims) ? args.claims.slice(0, 10) : [];
      return `Verify each of the following claims and return a JSON array of VerityResult objects. For each claim, keep summary to 1 sentence.\n\nClaims:\n${claims.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
    }
    default: // verity_agent
      return args.query;
  }
}

const CHECK_CREDITS_TOOL = {
  name:        "check_credits",
  description: "Check your remaining VERITY credit balance. Call this whenever you want to see how many credits you have left. Returns a warning if balance is low.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type:       "object",
    properties: {
      key: { type: "string", description: "Your VERITY API key (starts with pg_)" },
    },
    required: ["key"],
  },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Caller-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    return res.status(200).json({
      name:    "verity-mcp",
      version: "1.2.0",
      tools:   TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // PayGated auth — token embedded in PAYGATE_REMOTE_URL query string (PayGated preserves ?pg_token=... when proxying)
  const pgToken    = req.query.pg_token as string | undefined;
  const isPaygated = !!pgToken && !!process.env.PAYGATE_AUTH_SECRET && pgToken === process.env.PAYGATE_AUTH_SECRET;
  const defaultCallerId = (req.headers["caller_id"] ?? req.headers["x-caller-id"]) as string | undefined;

  const body = req.body as { jsonrpc: string; id: any; method: string; params?: any };
  const { id, method, params } = body;

  if (method === "initialize") {
    return res.json({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo:      { name: "verity-mcp", version: "1.2.0" },
        capabilities:    { tools: {}, prompts: {} },
        instructions: `Real-time fact-checking and misinformation detection agent. Catches AI hallucinations, verifies claims, detects outdated information. You have access to VERITY — a specialist real-time fact-checking and data freshness agent. Also used by A2A agent orchestrators to verify agent claims, credentials, and capability assertions before hiring via protocols like Swarmwage or MoltGig.

Use VERITY tools to verify claims, URLs, and content against live web sources before trusting or publishing them.

Tool selection guide:
- Quick claim check → verity_verify (0.10 USDC)
- High-stakes or complex claim → verity_deep_check (0.50 USDC)
- Auditing a piece of content with multiple claims → verity_batch (0.75 USDC)
- Natural language question → verity_agent (0.10 USDC)

VERITY returns structured verdicts: CURRENT, OUTDATED, DISPUTED, or UNVERIFIABLE — with confidence 0–100, sources, and exactly what has changed.

Pass a consistent caller_id to activate persistent memory. VERITY remembers domains and topics you've checked before.

Calls on this hosted endpoint are paid from VERITY credits (card). To pay per call in USDC on Base, run the local server (npx verity-mcp), which signs with a wallet that stays on your machine.`,
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

  if (method === "tools/list") return res.json({ jsonrpc: "2.0", id, result: { tools: [...TOOLS, CHECK_CREDITS_TOOL] } });

  if (method === "tools/call") {
    const { name, arguments: args } = params as { name: string; arguments: Record<string, any> };

    if (name === "check_credits") {
      const pgUrl      = process.env.PAYGATE_VERITY_URL;
      const pgAdminKey = process.env.PAYGATE_VERITY_ADMIN_KEY;
      const userKey    = (args.key || "").trim();
      if (!pgUrl || !pgAdminKey || !userKey) {
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Credit check unavailable — missing key or config." }] } });
      }
      try {
        const listRes = await fetch(`${pgUrl}/keys`, { headers: { "X-Admin-Key": pgAdminKey } });
        const allKeys = await listRes.json() as any[];
        const found   = allKeys.find((k: any) => k.keyPrefix && userKey.startsWith(k.keyPrefix.replace("...", "")));
        if (!found) {
          return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Key not found. Make sure you're using your full `pg_xxx...` API key." }] } });
        }
        const credits = found.credits as number;
        const text = credits < 100
          ? `⚠️ **Low balance: ${credits} credits remaining**\n\nTop up at: https://verity.basechainlabs.com/#get-access`
          : `✅ **${credits} credits remaining**\n\n10cr/verify · 50cr/deep-check · 75cr/batch · 10cr/agent`;
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
      } catch (e: any) {
        return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Could not check credits. Try again." }] } });
      }
    }

    const route = TOOL_ROUTES[name];

    if (!route) return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } });

    if (!isPaygated) {
      return res.json({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: "⚠️ **Payment not configured.**\n\nTwo options:\n\n**Option 1 — Pay with card (no wallet needed):**\nBuy credits at https://verity.basechainlabs.com/#get-access and use your API key as `VERITY_API_KEY` in settings.\n\n**Option 2 — Pay with USDC (x402):**\nRun VERITY locally with `npx verity-mcp` and set `VERITY_PRIVATE_KEY` on your own machine. Your key never leaves your computer; never send it to any hosted service." }] },
      });
    }

    try {
      const callerId = args.caller_id || defaultCallerId || "mcp-user";
      let text: string;
      const directive = buildVerityDirective(name, args);
      const result    = await runAgent({ query: directive, caller_id: callerId });
      text = result.response;
      return res.json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (e: any) {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32000, message: e.message } });
    }
  }

  return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}
