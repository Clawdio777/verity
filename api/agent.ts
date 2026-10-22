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
import type { PaymentRequired, PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { x402Version as X402_VERSION } from "@x402/core";
import { declareDiscoveryExtension } from "@x402/extensions";
import { runAgent } from "../src/agent.js";
import { waitUntil } from "@vercel/functions";
import {
  facilitatorClient, paymentsConfigured, PAYMENTS_NOT_CONFIGURED, DISCOVERY_CALLER_ID_EXAMPLE,
  settlePayment, alertPaidFailure, alertCarly, claimPayment, NOT_CHARGED_MESSAGE, type PendingPayment,
} from "./_x402-gate.js";

const PRICE_USDC = 0.10;
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Payment-Signature, X-Payment, Accept");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, PAYMENT-SIGNATURE");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET" && req.query.task_id) {
    return handleTaskPoll(req, res);
  }

  if (req.method === "GET") {
    return res.json(buildAgentCard());
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

  // PayGated internal bypass — already authenticated + billed via credit system
  const internalKey = req.headers["x-internal-key"] as string | undefined;
  if (internalKey && process.env.INTERNAL_API_KEY && internalKey === process.env.INTERNAL_API_KEY) {
    if (!query) return jsonRpcError(res, isJsonRpc, jsonRpcId, -32602, "Missing query");
    try {
      if (isStream) return await handleStream(res, query, caller_id);
      if (isAsync)  return await handleAsync(req, res, query, caller_id, isJsonRpc, jsonRpcId);
      return await handleSync(res, query, caller_id, isJsonRpc, jsonRpcId);
    } catch (e: any) {
      return jsonRpcError(res, isJsonRpc, jsonRpcId, -32000, e.message);
    }
  }

  if (!query) {
    if (!xPaymentHeader) return send402(res, buildPaymentRequirements());
    return jsonRpcError(res, isJsonRpc, jsonRpcId, -32602, "Missing query");
  }

  const paymentReqs = buildPaymentRequirements();
  if (!xPaymentHeader) return send402(res, paymentReqs);

  if (!paymentsConfigured()) {
    console.error("[verity] CDP_API_KEY_NAME / CDP_API_KEY_PRIVATE_KEY missing: refusing paid request");
    return res.status(500).json({ error: PAYMENTS_NOT_CONFIGURED });
  }

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

  // Verified, not settled: each pattern below settles only once it has a result to deliver
  // (see _x402-gate.ts "Charge only after the work succeeds").
  const payment: PendingPayment = { header: xPaymentHeader, payload: paymentPayload, reqs: paymentReqs };
  if (!(await claimPayment(res, payment))) return;

  try {
    if (isStream)  return await handleStream(res, query, caller_id, payment);
    if (isAsync)   return await handleAsync(req, res, query, caller_id, isJsonRpc, jsonRpcId, payment);
    return await handleSync(res, query, caller_id, isJsonRpc, jsonRpcId, payment);
  } catch (e: any) {
    // Not settled yet, so the buyer was not charged.
    await alertPaidFailure("agent", caller_id, e);
    return jsonRpcError(res, isJsonRpc, jsonRpcId, -32000, NOT_CHARGED_MESSAGE);
  }
}

async function handleSync(res: VercelResponse, query: string, caller_id: string, isJsonRpc: boolean, jsonRpcId: any, payment?: PendingPayment) {
  const result = await runAgent({ query, caller_id });
  if (payment) {
    const settled = await settlePayment(payment, "agent", caller_id);
    if (!settled.ok) return send402(res, payment.reqs!, settled.reason);
    if (settled.paymentResponse) res.setHeader("PAYMENT-RESPONSE", settled.paymentResponse);
  }
  await logVerification(caller_id, query, result).catch((e) => console.error("[verity] log write failed:", e.message));

  const body = {
    status:   "completed",
    artifact: { parts: [{ type: "text", text: result.response }], index: 0 },
    tool_calls: result.tool_calls_made,
    tokens: result.tokens_used,
  };
  return isJsonRpc ? res.json({ jsonrpc: "2.0", id: jsonRpcId, result: body }) : res.json(body);
}

async function handleAsync(req: VercelRequest, res: VercelResponse, query: string, caller_id: string, isJsonRpc: boolean, jsonRpcId: any, payment?: PendingPayment) {
  const { data: task, error } = await db
    .schema("verity").from("tasks")
    .insert({ caller_id, query, status: "working" })
    .select("id")
    .single();

  if (error || !task) return jsonRpcError(res, isJsonRpc, jsonRpcId, -32000, "Failed to create task");

  const immediate = { task_id: task.id, status: "working" };
  isJsonRpc ? res.json({ jsonrpc: "2.0", id: jsonRpcId, result: immediate }) : res.json(immediate);

  // Run after the response. waitUntil keeps the function alive until the run, settlement and task update
  // finish; without it Vercel may cut the work off once the response has been sent.
  waitUntil((async () => {
  // Once settled, the buyer has paid: a later failure must never be reported as "not charged".
  let charged = false;
  try {
    const result = await runAgent({ query, caller_id });
    let payment_response: string | undefined;
    if (payment) {
      const settled = await settlePayment(payment, "agent", caller_id);
      if (!settled.ok) {
        await db.schema("verity").from("tasks").update({
          status: "failed",
          error: `Payment could not be completed (${settled.reason}), so the result was not released. Nothing was charged.`,
          completed_at: new Date().toISOString(),
        }).eq("id", task.id);
        return;
      }
      payment_response = settled.paymentResponse;
      charged = true;
    }
    await logVerification(caller_id, query, result).catch((e) => console.error("[verity] log write failed:", e.message));
    await db.schema("verity").from("tasks").update({
      status: "completed",
      result: {
        artifact: { parts: [{ type: "text", text: result.response }], index: 0 },
        tokens: result.tokens_used,
        ...(payment_response && { payment_response }),
      },
      completed_at: new Date().toISOString(),
    }).eq("id", task.id);
  } catch (e: any) {
    if (charged) {
      await alertCarly(
        "VERITY: a paid async task was charged but its result could not be saved",
        `Caller: ${caller_id}\nTask: ${task.id}\nError: ${String(e?.message ?? e).slice(0, 500)}\n\nThe buyer paid. Resend the result or refund them.`,
      );
    } else if (payment) {
      await alertPaidFailure("agent", caller_id, e);
    }
    const error = charged
      ? "Your payment went through but the result could not be saved. VERITY has been alerted and will resend it or refund you."
      : payment ? NOT_CHARGED_MESSAGE : e.message;
    await db.schema("verity").from("tasks").update({ status: "failed", error, completed_at: new Date().toISOString() }).eq("id", task.id);
  }
  })().catch((e: any) => console.error("[verity] async task update failed:", e.message)));
}

async function handleTaskPoll(req: VercelRequest, res: VercelResponse) {
  const task_id = req.query.task_id as string;
  const { data: task, error } = await db
    .schema("verity").from("tasks")
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

async function handleStream(res: VercelResponse, query: string, caller_id: string, payment?: PendingPayment) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ status: "working", progress: "Starting VERITY verification..." });

  try {
    send({ status: "working", progress: "Searching live sources..." });
    const result = await runAgent({ query, caller_id });
    // Headers are already sent on a stream, so the settlement receipt goes in the final event.
    let payment_response: string | undefined;
    if (payment) {
      const settled = await settlePayment(payment, "agent", caller_id);
      if (!settled.ok) {
        send({ status: "failed", charged: false, error: `Payment could not be completed (${settled.reason}). Nothing was charged.` });
        return res.end();
      }
      payment_response = settled.paymentResponse;
    }
    await logVerification(caller_id, query, result).catch((e) => console.error("[verity] log write failed:", e.message));

    send({
      status: "completed",
      artifact: { parts: [{ type: "text", text: result.response }], index: 0 },
      tokens: result.tokens_used,
      ...(payment_response && { payment_response }),
    });
  } catch (e: any) {
    if (payment) await alertPaidFailure("agent", caller_id, e);
    send({ status: "failed", ...(payment && { charged: false }), error: payment ? NOT_CHARGED_MESSAGE : e.message });
  }

  res.end();
}

async function logVerification(caller_id: string, query: string, result: { tool_calls_made: string[]; tokens_used: number; response: string }) {
  const response = result.response;
  const verdict  = response.match(/"verdict"\s*:\s*"(\w+)"/)?.[1] ?? "UNVERIFIABLE";
  const confidence = parseInt(response.match(/"confidence"\s*:\s*(\d+)/)?.[1] ?? "0", 10);

  // supabase-js returns a failed insert as { error } instead of throwing: surface it so callers log it.
  const { error } = await db.schema("verity").from("verification_log").insert({
    caller_id,
    claim: query.substring(0, 500),
    verdict,
    confidence,
    sources_found: (response.match(/"url"\s*:/g) || []).length,
    url_checked: query.includes("http"),
    response_tokens: result.tokens_used,
    payment_usdc: PRICE_USDC,
  });
  if (error) throw new Error(error.message);
}

function buildPaymentRequirements(): PaymentRequirements {
  return {
    scheme:            "exact",
    network:           "eip155:8453",
    amount:            "100000",
    payTo:             (process.env.PAYMENT_ADDRESS || "0x400d65bb174c546ed92f5d61ce21fbde96b8bacc").trim(),
    maxTimeoutSeconds: 600, // room to finish the work (up to 300 s) before settling
    asset:             "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    extra:             { name: "USD Coin", version: "2" },
  };
}

const _bazaarBase = declareDiscoveryExtension({
  bodyType: "json",
  input: { query: "Is GPT-4 still the most capable AI model?", caller_id: DISCOVERY_CALLER_ID_EXAMPLE },
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
  const base = (process.env.AGENT_BASE_URL || "https://verity.basechainlabs.com").trim();
  const body: PaymentRequired = {
    x402Version: X402_VERSION,
    error:       errorReason ?? "payment-required",
    resource: {
      url:         `${base}/api/agent`,
      description: "Conversational fact-checking with persistent memory — VERITY remembers what your agent has checked across sessions, skipping repeat lookups. Returns CURRENT/OUTDATED/DISPUTED/UNVERIFIABLE verdicts with confidence scores and sources. 0.10 USDC/call.",
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
  const base = (process.env.AGENT_BASE_URL || "https://verity.basechainlabs.com").trim();
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
