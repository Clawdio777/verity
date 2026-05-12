/**
 * VERITY — ERC-8004 Independent Registration (2-step)
 *
 * Step 1: register() → mint token, get agentId
 * Step 2: build card with correct agentId → IPFS upload → setAgentURI()
 *
 * Usage:
 *   OWNER_PRIVATE_KEY=0x... PINATA_JWT=eyJ... node register-erc8004.mjs
 */

import { createWalletClient, createPublicClient, http, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const ABI = [
  { name: "register", type: "function", stateMutability: "nonpayable",
    inputs: [], outputs: [{ name: "agentId", type: "uint256" }] },
  { name: "setAgentURI", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }],
    outputs: [] },
  { name: "ownerOf", type: "function", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "address" }] },
  { name: "tokenURI", type: "function", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "string" }] },
  { name: "Transfer", type: "event",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ] },
];

function buildAgentCard(agentId) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "VERITY",
    description:
      "Real-time fact-checking and data freshness agent. Verifies claims, URLs, and content against live web sources. Returns structured verdicts (CURRENT / OUTDATED / DISPUTED / UNVERIFIABLE) with confidence scores, what-changed tracking, and supporting sources. Persistent memory per caller_id — agents stop re-verifying claims they've already confirmed. Protocols: A2A + x402 + MCP.",
    image: "https://verity.basechainlabs.com/verity-logo.jpg",
    services: [
      { name: "A2A", endpoint: "https://verity.basechainlabs.com/api/agent", version: "1.0.0" },
      { name: "web", endpoint: "https://verity.basechainlabs.com" },
    ],
    x402Support: true,
    active: true,
    registrations: [
      { agentId: Number(agentId), agentRegistry: `eip155:8453:${REGISTRY}` },
    ],
    supportedTrust: ["reputation", "crypto-economic"],
  };
}

async function uploadToIPFS(card, jwt) {
  const body = JSON.stringify({
    pinataContent: card,
    pinataMetadata: { name: `verity-erc8004-${card.registrations[0].agentId}.json` },
    pinataOptions: { cidVersion: 1 },
  });

  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body,
  });

  if (!res.ok) throw new Error(`Pinata upload failed: ${res.status} ${await res.text()}`);
  return (await res.json()).IpfsHash;
}

async function main() {
  const pk = process.env.OWNER_PRIVATE_KEY;
  const jwt = process.env.PINATA_JWT;

  if (!pk) { console.error("OWNER_PRIVATE_KEY env var required"); process.exit(1); }
  if (!jwt) { console.error("PINATA_JWT env var required"); process.exit(1); }

  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const walletClient = createWalletClient({ account, chain: base, transport: http() });

  console.log(`\nWallet:   ${account.address}`);
  console.log(`Registry: ${REGISTRY}\n`);

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`ETH balance: ${(Number(balance) / 1e18).toFixed(6)} ETH`);
  if (balance < 100000000000000n) {
    console.error("❌ Low balance — need at least 0.0001 ETH for gas (two txs)");
    process.exit(1);
  }
  console.log("✅ Sufficient balance\n");

  console.log("── Step 1: Minting ERC-8004 token (no URI yet)...");
  const hash1 = await walletClient.writeContract({
    address: REGISTRY, abi: ABI, functionName: "register", args: [],
  });
  console.log(`   tx: ${hash1}`);

  console.log("   Waiting for confirmation...");
  const receipt1 = await publicClient.waitForTransactionReceipt({ hash: hash1 });
  console.log(`   ✅ Confirmed in block ${receipt1.blockNumber}`);

  let agentId;
  for (const log of receipt1.logs) {
    try {
      const event = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics });
      if (
        event.eventName === "Transfer" &&
        event.args.from === "0x0000000000000000000000000000000000000000"
      ) {
        agentId = event.args.tokenId;
        break;
      }
    } catch {}
  }

  if (agentId === undefined) {
    console.error("❌ Could not parse agentId from tx logs");
    console.error(`   Check manually: https://basescan.org/tx/${hash1}`);
    process.exit(1);
  }
  console.log(`\n   🎉 New Agent ID: ${agentId}\n`);

  console.log("── Step 2: Building agent card with correct agentId...");
  const card = buildAgentCard(agentId);
  console.log(`   registrations[0].agentId = ${card.registrations[0].agentId}`);
  console.log(`   supportedTrust = ${JSON.stringify(card.supportedTrust)}`);

  console.log("\n   Uploading to IPFS via Pinata...");
  const cid = await uploadToIPFS(card, jwt);
  const ipfsURI = `ipfs://${cid}`;
  console.log(`   ✅ Pinned: ${ipfsURI}`);
  console.log(`   Gateway:  https://gateway.pinata.cloud/ipfs/${cid}\n`);

  console.log("   Calling setAgentURI...");
  const hash2 = await walletClient.writeContract({
    address: REGISTRY, abi: ABI, functionName: "setAgentURI", args: [agentId, ipfsURI],
  });
  console.log(`   tx: ${hash2}`);

  console.log("   Waiting for confirmation...");
  const receipt2 = await publicClient.waitForTransactionReceipt({ hash: hash2 });
  console.log(`   ✅ Confirmed in block ${receipt2.blockNumber}`);

  const finalURI = await publicClient.readContract({
    address: REGISTRY, abi: ABI, functionName: "tokenURI", args: [agentId],
  });
  const owner = await publicClient.readContract({
    address: REGISTRY, abi: ABI, functionName: "ownerOf", args: [agentId],
  });

  console.log(`\n${"─".repeat(60)}`);
  console.log(`✅ VERITY registered on ERC-8004`);
  console.log(`   Agent ID:  ${agentId}`);
  console.log(`   Owner:     ${owner}`);
  console.log(`   Token URI: ${finalURI}`);
  console.log(`\n   8004scan:  https://8004scan.io/agents/base/${agentId}?tab=metadata`);
  console.log(`   BaseScan:  https://basescan.org/token/${REGISTRY}?a=${agentId}`);
  console.log(`${"─".repeat(60)}\n`);
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message}`);
  process.exit(1);
});
