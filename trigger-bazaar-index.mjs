/**
 * Trigger agentic.market Bazaar indexing for VERITY
 * x402 v2 protocol — uses @x402/fetch + @x402/evm/exact/client
 *
 * Usage: OWNER_PRIVATE_KEY=0x... node trigger-bazaar-index.mjs
 */

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const AGENT_URL = "https://verity.basechainlabs.com/api/agent";

async function main() {
  const pk = process.env.OWNER_PRIVATE_KEY;
  if (!pk) { console.error("OWNER_PRIVATE_KEY required"); process.exit(1); }

  const evmSigner = privateKeyToAccount(pk);
  console.log(`\nWallet: ${evmSigner.address}`);
  console.log(`Hitting: ${AGENT_URL}\n`);

  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(evmSigner));

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log("Step 1: Probing for 402 (POST without payment)...");
  const probe = await fetch(AGENT_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  console.log(`Probe status: ${probe.status}`);
  if (probe.status === 402) {
    const paymentRequired = await probe.json();
    console.log("x402Version:", paymentRequired.x402Version);
    console.log("extensions.bazaar present:", !!paymentRequired?.extensions?.bazaar);
    console.log("resource.url:", paymentRequired?.resource?.url);
  } else {
    console.error(`Expected 402, got ${probe.status} — check server`);
    process.exit(1);
  }

  console.log("\nStep 2: Sending paid request (auto-payment via @x402/fetch)...");
  const paid = await fetchWithPayment(AGENT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "Is Claude Sonnet 4.6 the latest Sonnet model?",
      caller_id: "bazaar-index-trigger",
    }),
  });

  console.log(`\nResponse status: ${paid.status}`);

  if (paid.ok) {
    const result = await paid.json();
    console.log("✅ Payment accepted — CDP Facilitator processed this payment");
    console.log("   Bazaar indexing should trigger within 5–10 minutes");
    console.log("\nArtifact preview:");
    const text = result?.artifact?.parts?.[0]?.text ?? result?.result ?? JSON.stringify(result);
    console.log(text.slice(0, 300) + "...");
  } else {
    const err = await paid.text();
    console.error(`❌ Payment failed: ${paid.status} ${err}`);
  }

  console.log(`\nCheck listing: https://agentic.market/?search=verity`);
  console.log(`Validate endpoint: https://agentic.market/validate`);
  console.log(`(Allow 5–15 mins for indexing)\n`);
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
