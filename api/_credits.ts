/**
 * Card credits (18/11/2026): the `pg_` API keys bought by card, and their balances, kept in Supabase
 * (tables credit_keys + credit_ledger in the shared AEONOS database; migration
 * 004_card_credits.sql). Replaces the PayGate proxy that ran on Railway.
 * Only the sha256 hash of a key is stored. Charges are atomic; a failed call is refunded once.
 * Card credits only: nothing here touches USDC/x402 payments.
 */

import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const AGENT = "verity";

/** Credits per call. Same prices PayGate charged (PAYGATE_TOOL_PRICE; unlisted tools cost 1). 1 credit = US$0.01. */
export const PRICES: Record<string, number> = {
  verity_verify:     10,
  verity_deep_check: 50,
  verity_batch:      75,
  verity_agent:      10,
  check_credits:     1,
};

const KEY_RE = /^pg_[0-9a-f]{48}$/;

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** A new key in PayGate's format, so old and new keys look the same to buyers. */
export const newKey = () => `pg_${randomBytes(24).toString("hex")}`;

/** The buyer's key from `X-Api-Key` (what PayGate read) or `Authorization: Bearer pg_…`. */
export function readApiKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim();
  const x = first(headers["x-api-key"]);
  if (x) return x;
  const auth = first(headers["authorization"]);
  if (auth?.startsWith("Bearer pg_")) return auth.slice(7).trim();
  return undefined;
}

let db: SupabaseClient | undefined;
function client(): SupabaseClient {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("credits store not configured");
  return (db ??= createClient(url, key, { auth: { persistSession: false } }));
}

export type Charge =
  | { ok: true; chargeId: number; balance: number }
  | { ok: false; reason: "not_found" | "inactive" | "insufficient"; balance: number };

export async function charge(key: string, tool: string, amount: number): Promise<Charge> {
  if (!KEY_RE.test(key)) return { ok: false, reason: "not_found", balance: 0 };
  const { data, error } = await client().rpc("credit_charge", {
    p_agent: AGENT, p_key_hash: hashKey(key), p_amount: amount, p_tool: tool,
  });
  if (error) throw new Error(`credit charge failed: ${error.message}`);
  const row = (data as any[])[0];
  return row.ok
    ? { ok: true, chargeId: Number(row.charge_id), balance: row.balance }
    : { ok: false, reason: row.reason, balance: row.balance };
}

/** Gives one charge back. Safe to repeat. */
export async function refund(chargeId: number): Promise<number> {
  const { data, error } = await client().rpc("credit_refund", { p_charge_id: chargeId });
  if (error) throw new Error(`credit refund failed: ${error.message}`);
  return data as number;
}

/** Balance of a key, or null when the key is unknown. Free; no charge. */
export async function balance(key: string): Promise<number | null> {
  if (!KEY_RE.test(key)) return null;
  const { data, error } = await client().from("credit_keys").select("credits")
    .eq("key_hash", hashKey(key)).eq("agent", AGENT).maybeSingle();
  if (error) throw new Error(`credit lookup failed: ${error.message}`);
  return data ? (data as any).credits : null;
}

/** Adds a paid checkout's credits to its key, once per Stripe session (repeats change nothing). */
export async function topup(key: string, credits: number, stripeSessionId: string, name: string) {
  if (!KEY_RE.test(key)) throw new Error("not a pg_ key");
  const { data, error } = await client().rpc("credit_topup", {
    p_agent: AGENT, p_key_hash: hashKey(key), p_key_prefix: key.slice(0, 10), p_name: name,
    p_credits: credits, p_ref: stripeSessionId,
  });
  if (error) throw new Error(`credit topup failed: ${error.message}`);
  const row = (data as any[])[0];
  return { applied: row.applied as boolean, balance: row.balance as number };
}

/**
 * Charge `tool`'s price, run the work, and refund if it throws or runs past `timeoutMs`
 * (so a call cut off at the function's time limit is never kept). Mirrors PayGate --refund-on-failure.
 */
export async function paidRun<T>(key: string, tool: string, work: () => Promise<T>, timeoutMs: number):
  Promise<{ ok: true; value: T; balance: number } | { ok: false; refused: Charge & { ok: false } } | { ok: false; error: Error; refunded: boolean }> {
  const amount = PRICES[tool] ?? 1;
  const c = await charge(key, tool, amount);
  if (!c.ok) return { ok: false, refused: c };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Request timed out")), timeoutMs); }),
    ]);
    return { ok: true, value, balance: c.balance };
  } catch (e: any) {
    let refunded = false;
    try { await refund(c.chargeId); refunded = true; }
    catch (re: any) { console.error(`[credits] REFUND FAILED for charge ${c.chargeId}:`, re.message); }
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)), refunded };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Buyer-facing text for a refused charge. */
export function refusedText(r: { reason: string; balance: number }, tool: string, topUpUrl: string): string {
  if (r.reason === "insufficient")
    return `Insufficient credits: ${tool} costs ${PRICES[tool] ?? 1} credits, you have ${r.balance}. Top up at ${topUpUrl}`;
  if (r.reason === "inactive") return "This API key has been disabled.";
  return "Invalid API key. Use the full pg_… key from your purchase email, or recover it at " + topUpUrl;
}
