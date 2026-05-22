/**
 * seller-v2.mjs — VERITY ACP v2 event-driven provider runtime
 *
 * Mirrors the AEONOS seller pattern. Spawns `acp events listen`,
 * processes job events, calls the VERITY Vercel API, and submits
 * deliverables back through the ACP CLI.
 */

import { createInterface } from "readline";
import { execFileSync, execSync, spawn } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Config ─────────────────────────────────────────────────────────────────────

const VERITY_API_BASE = "https://verity.basechainlabs.com";
const ACP_API         = "https://api.acp.virtuals.io";
const CHAIN_ID        = 8453;

const ACP_BIN = process.env.ACP_BIN
  || (() => { try { return execSync("which acp", { encoding: "utf8" }).trim(); } catch { return null; } })()
  || "/Users/clawdiovandamme/.nvm/versions/node/v20.20.0/bin/acp";

const RESTART_DELAY_MS  = 5_000;
const VERITY_TIMEOUT_MS = 120_000; // 2 min
const ACP_TIMEOUT_MS    = 60_000;

// Offering name → endpoint + fee
const OFFERINGS = {
  verity_verify:       { endpoint: "/api/verify",       fee: "0.10" },
  verity_deep_check:   { endpoint: "/api/deep-check",   fee: "0.50" },
  verity_batch_verify: { endpoint: "/api/batch-verify", fee: "0.75" },
  verity_agent:        { endpoint: "/api/agent",        fee: "0.10" },
};

// Sweep config — same personal wallet as AEONOS
const SWEEP_DEST      = "0x282d873b3737144b45c507320c12f22edfd51fe3";
const SWEEP_THRESHOLD = 5.00; // USDC — sweep when VERITY balance ≥ this
const USDC_CONTRACT   = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_RPC        = "https://mainnet.base.org";

const LOG_DIR = process.env.LOG_DIR
  || join(homedir(), "Library", "Logs", "verity-seller");
mkdirSync(LOG_DIR, { recursive: true });

// ── Logging ────────────────────────────────────────────────────────────────────

function log(...args) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${args.join(" ")}`;
  console.log(line);
  try {
    const date = ts.slice(0, 10);
    writeFileSync(join(LOG_DIR, `${date}.log`), line + "\n", { flag: "a" });
  } catch {}
}

function jobLog(jobId, ...args) {
  log(`[Job ${jobId ?? "?"}]`, ...args);
}

// ── Job state ──────────────────────────────────────────────────────────────────

const jobs = new Map();

function getJob(jobId, chainId) {
  if (!jobs.has(jobId)) {
    jobs.set(jobId, { chainId: chainId ?? CHAIN_ID, requirement: null, offeringName: null, budgetSet: false, submitted: false });
  }
  return jobs.get(jobId);
}

// ── Event handler ──────────────────────────────────────────────────────────────

async function handleEvent(raw) {
  let event;
  try { event = JSON.parse(raw); } catch { return; }

  const { jobId, chainId, availableTools = [], entry, status, roles = [] } = event;
  if (!jobId) return;
  if (!roles.includes("provider")) return;

  const job = getJob(jobId, chainId);

  // Store requirement
  if (entry?.kind === "message" && entry.contentType === "requirement") {
    try {
      job.requirement = typeof entry.content === "string"
        ? JSON.parse(entry.content)
        : entry.content;
    } catch {
      job.requirement = { query: String(entry.content) };
    }
    jobLog(jobId, "Requirement:", JSON.stringify(job.requirement).slice(0, 120));
  }

  // Set budget
  if (availableTools.includes("set-budget") && !job.budgetSet) {
    job.budgetSet = true;
    try {
      const fee = await resolveOfferingFee(jobId, job.chainId);
      jobLog(jobId, `Setting budget: ${fee} USDC`);
      const out = execFileSync(ACP_BIN, [
        "provider", "set-budget",
        "--job-id",   jobId,
        "--amount",   fee,
        "--chain-id", String(job.chainId),
      ], { encoding: "utf8", timeout: ACP_TIMEOUT_MS, env: acpEnv() });
      jobLog(jobId, "Budget set OK:", out.trim().slice(0, 120));
    } catch (e) {
      jobLog(jobId, "set-budget ERROR:", e.message.slice(0, 200));
      job.budgetSet = false;
    }
  }

  // Submit deliverable
  if (availableTools.includes("submit") && status === "funded" && !job.submitted) {
    job.submitted = true;

    if (!job.requirement) {
      job.requirement = await fetchRequirementFallback(jobId, job.chainId);
    }

    const query     = job.requirement?.query     ?? "Verify this claim";
    const caller_id = job.requirement?.caller_id ?? `acp_${jobId.slice(0, 16)}`;
    const offering  = job.offeringName ?? "verity_verify";
    const config    = OFFERINGS[offering] ?? OFFERINGS.verity_verify;

    jobLog(jobId, `Offering: ${offering} | Endpoint: ${config.endpoint} | Query:`, query.slice(0, 100));

    try {
      const res = await fetch(`${VERITY_API_BASE}${config.endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, caller_id }),
        signal: AbortSignal.timeout(VERITY_TIMEOUT_MS),
      });

      if (!res.ok) {
        throw new Error(`VERITY API ${res.status}: ${await res.text().then(t => t.slice(0, 200))}`);
      }

      const data = await res.json();
      const deliverable = data.artifact?.parts?.[0]?.text
        ?? data.response
        ?? data.result
        ?? JSON.stringify(data);

      jobLog(jobId, `VERITY response (${deliverable.length} chars). Submitting...`);

      execFileSync(ACP_BIN, [
        "provider", "submit",
        "--job-id",      jobId,
        "--deliverable", deliverable,
        "--chain-id",    String(job.chainId),
      ], { encoding: "utf8", timeout: ACP_TIMEOUT_MS, env: acpEnv() });

      jobLog(jobId, "Submitted ✓");
      jobs.delete(jobId);
      sweepIfNeeded().catch(e => log("[Sweep] unhandled:", e.message));

    } catch (e) {
      jobLog(jobId, "Submit ERROR:", e.message.slice(0, 300));
      job.submitted = false;
    }
  }

  // Clean up
  if (["completed", "rejected", "expired"].includes(status) && !availableTools.length) {
    jobLog(jobId, `Job ${status} — cleaning up`);
    jobs.delete(jobId);
  }
}

// ── Fee resolution ─────────────────────────────────────────────────────────────

async function resolveOfferingFee(jobId, chainId) {
  try {
    const res = await fetch(`${ACP_API}/jobs/${chainId}/${jobId}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const data = await res.json();
      const name = data.description ?? data.offeringName;
      if (name && OFFERINGS[name]) {
        const job = jobs.get(jobId);
        if (job) job.offeringName = name;
        log(`[Fee] ${jobId} → ${name} = ${OFFERINGS[name].fee} USDC`);
        return OFFERINGS[name].fee;
      }
    }
  } catch {}
  log(`[Fee] ${jobId} → defaulting to ${OFFERINGS.verity_verify.fee} USDC`);
  return OFFERINGS.verity_verify.fee;
}

// ── Requirement fallback ───────────────────────────────────────────────────────

async function fetchRequirementFallback(jobId, chainId) {
  try {
    const out = execFileSync(ACP_BIN, [
      "job", "history",
      "--job-id",   jobId,
      "--chain-id", String(chainId),
      "--json",
    ], { encoding: "utf8", timeout: 15_000, env: acpEnv() });
    const data = JSON.parse(out);
    const reqEntry = data.entries?.find(e => e.kind === "message" && e.contentType === "requirement");
    if (reqEntry) {
      try { return JSON.parse(reqEntry.content); }
      catch { return { query: reqEntry.content }; }
    }
  } catch (e) {
    log(`[Fallback] requirement fetch failed for ${jobId}:`, e.message.slice(0, 120));
  }
  return null;
}

// ── Sweeper ────────────────────────────────────────────────────────────────────

async function getUSDCBalance(address) {
  try {
    const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
    const res = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC_CONTRACT, data }, "latest"] }),
    });
    const json = await res.json();
    if (!json.result || json.result === "0x") return 0;
    return parseInt(json.result, 16) / 1_000_000;
  } catch { return 0; }
}

function sendUSDC(toAddress, amount) {
  const units    = BigInt(Math.floor(amount * 1_000_000));
  const dest     = toAddress.slice(2).toLowerCase().padStart(64, "0");
  const amt      = units.toString(16).padStart(64, "0");
  const calldata = `0xa9059cbb${dest}${amt}`;
  return execFileSync(ACP_BIN, [
    "wallet", "send-transaction",
    "--chain-id", String(CHAIN_ID),
    "--to",   USDC_CONTRACT,
    "--data", calldata,
  ], { encoding: "utf8", timeout: 60_000, env: acpEnv() }).trim().slice(0, 120);
}

async function sweepIfNeeded() {
  try {
    const balOut = execFileSync(ACP_BIN, [
      "wallet", "balance", "--chain-id", String(CHAIN_ID),
    ], { encoding: "utf8", timeout: 30_000, env: acpEnv() });

    const match = balOut.match(/^USDC\s+\S+\s+([\d.]+)/m);
    if (!match) { log("[Sweep] Could not parse USDC balance"); return; }

    const balance = parseFloat(match[1]);
    if (balance < SWEEP_THRESHOLD) {
      log(`[Sweep] ${balance} USDC — below threshold, skipping`);
      return;
    }

    log(`[Sweep] ${balance} USDC ≥ ${SWEEP_THRESHOLD} — sweeping to personal wallet`);
    const tx = sendUSDC(SWEEP_DEST, balance);
    log(`[Sweep] Swept ${balance} USDC. TX: ${tx}`);
  } catch (e) {
    log("[Sweep] ERROR:", e.message.slice(0, 200));
  }
}

// ── ACP environment helper ─────────────────────────────────────────────────────

function acpEnv() {
  return {
    ...process.env,
    HOME: process.env.HOME || homedir(),
    TS_KEYRING_BACKEND: "file",
    PATH: `${ACP_BIN.replace(/\/acp$/, "")}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
    ...(process.env.XDG_CONFIG_HOME && { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }),
    ...(process.env.XDG_DATA_HOME   && { XDG_DATA_HOME:   process.env.XDG_DATA_HOME   }),
    ...(process.env.ACP_CONFIG_DIR  && { ACP_CONFIG_DIR:  process.env.ACP_CONFIG_DIR  }),
  };
}

// ── Event stream (auto-restart) ────────────────────────────────────────────────

function startEventStream() {
  log("Starting `acp events listen`...");

  const proc = spawn(ACP_BIN, ["events", "listen"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: acpEnv(),
  });

  const rl = createInterface({ input: proc.stdout, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (trimmed) handleEvent(trimmed).catch(e => log("handleEvent error:", e.message));
  });

  proc.stderr.on("data", (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) log("[acp stderr]", msg.slice(0, 200));
  });

  proc.on("exit", (code, signal) => {
    log(`acp events listen exited (code=${code}, signal=${signal}). Restarting in ${RESTART_DELAY_MS / 1000}s...`);
    setTimeout(startEventStream, RESTART_DELAY_MS);
  });

  proc.on("error", (e) => {
    log("acp events listen spawn error:", e.message);
    setTimeout(startEventStream, RESTART_DELAY_MS);
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────────

process.on("uncaughtException",  (e) => log("uncaughtException:",  e.message, e.stack?.slice(0, 500)));
process.on("unhandledRejection", (e) => log("unhandledRejection:", String(e)));

log("VERITY seller-v2 started. Logs:", LOG_DIR);
startEventStream();
