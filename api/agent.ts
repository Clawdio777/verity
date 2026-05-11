/**
 * api/agent.ts — VERITY primary A2A + x402 endpoint
 *
 * Natural language fact-checking. "Is this still true?", "Check this URL",
 * "When was this last updated?" — VERITY picks the right verification strategy.
 *
 * Supports: sync, async (task polling), SSE streaming, A2A JSON-RPC 2.0.
 * 0.10 USDC per call.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentRequired, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { x402Version as X402_VERSION } from "@x402/core";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension } from "@x402/extensions";
import { runAgent } from "../src/agent.js";

const facilitatorClient = new HTTPFacilitatorClient(
  process.env.CDP_API_KEY_NAME && process.env.CDP_API_KEY_PRIVATE_KEY
    ? createFacilitatorConfig(
        process.env.CDP_API_KEY_NAME.trim(),
        process.env.CDP_API_KEY_PRIVATE_KEY.trim()
      )
    : {}
);

const PRICE_USDC = 0.10;
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Payment-Signature, X-Payment, Accept");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, PAYMENT-SIGNATURE");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET" && req.query["agent-card"]) {
    return res.json(buildAgentCard());
  }

  if (req.method === "GET" && req.query.task_id) {
    return handleTaskPoll(req, res);
  }

  if (req.method === "GET") {
    return send402(res, buildPaymentRequirements());
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const body       = req.body;
  const isJsonRpc  = body?.jsonrpc === "2.0";
  const isStream   = req.query.stream === "true" || req.headers.accept?.includes("text/event-stream");
  const isAsync    = req.query.async === "true";
  const jsonRpcId  = body?.id ?? null;

  let query:     string;
  let caller_id: string;

  if (isJsonRpc) {
    query     = body.params?.query || body.params?.message || "";
    caller_id = body.params?.caller_id || "anon";
  } else {
    query     = body?.query || body?.message || body?.claim || "";
    caller_id = body?.caller_id || "anon";
  }

  const xPaymentHeader = (req.headers["payment-signature"] ?? req.headers["x-payment"]) as string | undefined;

  if (!query) {
    if (!xPaymentHeader) return send402(res, buildPaymentRequirements());
    return jsonRpcError(res, isJsonRpc, jsonRpcId, -32602, "Missing query");
  }

  const paymentReqs = buildPaymentRequirements();
  if (!xPaymentHeader) return send402(res, paymentReqs);

  let paymentPayload: PaymentPayload;
  try {
    paymentPayload = JSON.parse(Buffer.from(xPaymentHeader, "base64").toString("utf8")) as PaymentPayload;
  } catch {
    return send402(res, paymentReqs, "invalid_payment");
  }

  let verifyResult: { isValid: boolean; invalidReason?: string };
  try {
    verifyResult = await facilitatorClient.verify(paymentPayload, paymentReqs);
  } catch (e: any) {
    return res.status(500).json({ error: "Payment verification failed", detail: e.message });
  }
  if (!verifyResult.isValid) return send402(res, paymentReqs, verifyResult.invalidReason);

  let settleResult: { success: boolean; errorReason?: string };
  try {
    settleResult = await facilitatorClient.settle(paymentPayload, paymentReqs);
  } catch (e: any) {
    return res.status(500).json({ error: "Payment settlement failed", detail: e.message });
  }
  if (!settleResult.success) return send402(res, paymentReqs, settleResult.errorReason);

  res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settleResult)).toString("base64"));

  try {
    if (isStream)  return await handleStream(res, query, caller_id);
    if (isAsync)   return await handleAsync(req, res, query, caller_id, isJsonRpc, jsonRpcId);
    return await handleSync(res, query, caller_id, isJsonRpc, jsonRpcId);
  } catch (e: any) {
    return jsonRpcError(res, isJsonRpc, jsonRpcId, -32000, e.message);
  }
}

async function handleSync(res: VercelResponse, query: string, caller_id: string, isJsonRpc: boolean, jsonRpcId: any) {
  const result = await runAgent({ query, caller_id });
  await logVerification(caller_id, query, result);

  const body = {
    status:   "completed",
    artifact: { parts: [{ type: "text", text: result.response }], index: 0 },
    tool_calls: result.tool_calls_made,
    tokens: result.tokens_used,
  };
  return isJsonRpc ? res.json({ jsonrpc: "2.0", id: jsonRpcId, result: body }) : res.json(body);
}

async function handleAsync(req: VercelRequest, res: VercelResponse, query: string, caller_id: string, isJsonRpc: boolean, jsonRpcId: any) {
  const { data: task, error } = await db
    .from("tasks")
    .insert({ caller_id, query, status: "working" })
    .select("id")
    .single();

  if (error || !task) return jsonRpcError(res, isJsonRpc, jsonRpcId, -32000, "Failed to create task");

  const immediate = { task_id: task.id, status: "working" };
  isJsonRpc ? res.json({ jsonrpc: "2.0", id: jsonRpcId, result: immediate }) : res.json(immediate);

  try {
    const result = await runAgent({ query, caller_id });
    await logVerification(caller_id, query, result);
    await db.from("tasks").update({
      status: "completed",
      result: { artifact: { parts: [{ type: "text", text: result.response }], index: 0 }, tokens: result.tokens_used },
      completed_at: new Date().toISOString(),
    }).eq("id", task.id);
  } catch (e: any) {
    await db.from("tasks").update({ status: "failed", error: e.message, completed_at: new Date().toISOString() }).eq("id", task.id);
  }
}

async function handleTaskPoll(req: VercelRequest, res: VercelResponse) {
  const task_id = req.query.task_id as string;
  const { data: task, error } = await db
    .from("tasks")
    .select("id, status, result, error, created_at, completed_at")
    .eq("id", task_id)
    .single();

  if (error || !task) return res.status(404).json({ error: "Task not found" });
  return res.json({
    task_id: task.id,
    status: task.status,
    ...(task.status === "completed" && { artifact: task.result?.artifact }),
    ...(task.status === "failed" && { error: task.error }),
    created_at: task.created_at,
    completed_at: task.completed_at,
  });
}

async function handleStream(res: VercelResponse, query: string, caller_id: string) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ status: "working", progress: "Starting VERITY verification..." });

  try {
    send({ status: "working", progress: "Searching live sources..." });
    const result = await runAgent({ query, caller_id });
    await logVerification(caller_id, query, result);

    send({
      status: "completed",
      artifact: { parts: [{ type: "text", text: result.response }], index: 0 },
      tokens: result.tokens_used,
    });
  } catch (e: any) {
    send({ status: "failed", error: e.message });
  }

  res.end();
}

async function logVerification(caller_id: string, query: string, result: { tool_calls_made: string[]; tokens_used: number; response: string }) {
  const response = result.response;
  const verdict  = response.match(/"verdict"\s*:\s*"(\w+)"/)?.[1] ?? "UNVERIFIABLE";
  const confidence = parseInt(response.match(/"confidence"\s*:\s*(\d+)/)?.[1] ?? "0", 10);

  await db.from("verification_log").insert({
    caller_id,
    claim: query.substring(0, 500),
    verdict,
    confidence,
    sources_found: (response.match(/"url"\s*:/g) || []).length,
    url_checked: query.includes("http"),
    response_tokens: result.tokens_used,
    payment_usdc: PRICE_USDC,
  });
}

function buildPaymentRequirements(): PaymentRequirements {
  return {
    scheme:            "exact",
    network:           "eip155:8453",
    amount:            "100000",
    payTo:             (process.env.PAYMENT_ADDRESS || "0x400d65bb174c546ed92f5d61ce21fbde96b8bacc").trim(),
    maxTimeoutSeconds: 300,
    asset:             "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    extra:             { name: "USD Coin", version: "2" },
  };
}

const _bazaarBase = declareDiscoveryExtension({
  bodyType: "json",
  input: { query: "Is GPT-4 still the most capable AI model?", caller_id: "my-agent-id" },
  inputSchema: {
    properties: {
      query:     { type: "string", description: "Claim, URL, or question to verify. E.g. 'Is X still true?', 'Check this URL: https://...'." },
      caller_id: { type: "string", description: "Optional stable ID for persistent memory across verification sessions." },
    },
    required: ["query"],
  },
  output: {
    example: {
      status: "completed",
      artifact: { parts: [{ type: "text", text: '{"verdict":"OUTDATED","confidence":91,"summary":"...","sources":[...]}' }], index: 0 },
    },
    schema: { properties: { status: { type: "string" }, artifact: { type: "object" }, tokens: { type: "number" } } },
  },
});

const BAZAAR_EXTENSION = {
  bazaar: {
    ..._bazaarBase.bazaar,
    info: { ..._bazaarBase.bazaar.info, input: { ..._bazaarBase.bazaar.info.input, method: "POST" } },
    serviceName: "VERITY",
    tags: ["fact-check", "verification", "data-freshness", "hallucination", "claim-check"],
    iconUrl: "https://verity.basechainlabs.com/verity-logo.jpg",
  },
};

function send402(res: VercelResponse, paymentReqs: PaymentRequirements, errorReason?: string) {
  const base = process.env.AGENT_BASE_URL || "https://verity.basechainlabs.com";
  const body: PaymentRequired = {
    x402Version: X402_VERSION,
    error:       errorReason ?? "payment-required",
    resource: {
      url:         `${base}/api/agent`,
      description: "Real-time fact-checking agent. Verifies claims against live web sources. Returns CURRENT/OUTDATED/DISPUTED/UNVERIFIABLE verdict with confidence score. 0.10 USDC/call.",
      mimeType:    "application/json",
    },
    accepts:    [paymentReqs],
    extensions: BAZAAR_EXTENSION,
  };
  res.setHeader("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(body)).toString("base64"));
  return res.status(402).json(body);
}

function jsonRpcError(res: VercelResponse, isJsonRpc: boolean, id: any, code: number, message: string) {
  if (isJsonRpc) return res.json({ jsonrpc: "2.0", id, error: { code, message } });
  return res.status(code === -32602 ? 400 : 500).json({ error: message });
}

function buildAgentCard() {
  const base = process.env.AGENT_BASE_URL || "https://verity.basechainlabs.com";
  return {
    name: "VERITY",
    description: "Real-time fact-checking and data freshness agent. Verifies claims, URLs, and content against live web sources. Returns structured verdicts (CURRENT/OUTDATED/DISPUTED/UNVERIFIABLE) with confidence scores, what changed, and persistent caller memory.",
    url: `${base}/api/agent`,
    version: "1.0.0",
    protocolVersion: "0.2.1",
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: true },
    skills: [
      {
        id: "claim_verify",
        name: "Claim Verification",
        description: "Verify any claim against live web sources. Returns CURRENT/OUTDATED/DISPUTED/UNVERIFIABLE with confidence 0–100.",
        tags: ["fact-check", "verification", "claim"],
        endpoint: `${base}/api/verify`,
        price: "0.10 USDC",
      },
      {
        id: "deep_check",
        name: "Deep Fact Check",
        description: "Multi-angle thorough verification with advanced search depth. For high-stakes checks.",
        tags: ["fact-check", "deep-research"],
        endpoint: `${base}/api/deep-check`,
        price: "0.50 USDC",
      },
      {
        id: "batch_verify",
        name: "Batch Verify",
        description: "Verify up to 10 claims in one call. For content audits and fact-check pipelines.",
        tags: ["batch", "bulk", "pipeline"],
        endpoint: `${base}/api/batch-verify`,
        price: "0.75 USDC",
      },
    ],
    pricing: {
      standard: "0.10 USDC — single claim verify",
      deep:     "0.50 USDC — deep multi-angle check",
      batch:    "0.75 USDC — up to 10 claims",
    },
    protocols: ["x402", "a2a"],
    network: "base",
    payment_address: process.env.PAYMENT_ADDRESS || "",
  };
}
