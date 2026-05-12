/**
 * VERITY — Update ERC-8004 agent card (re-uploads IPFS, then setAgentURI on agent 50896)
 *
 * Lead the description with persistent memory so 8004scan's truncated UI
 * shows it as the headline feature.
 *
 * Usage:
 *   OWNER_PRIVATE_KEY=0x... PINATA_JWT=eyJ... node update-erc8004.mjs
 */

import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const AGENT_ID = 50896n;

const ABI = [
  { name: "setAgentURI", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "agentId", type: "uint256" }, { name: "newURI", type: "string" }],
    outputs: [] },
  { name: "ownerOf", type: "function", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "address" }] },
  { name: "tokenURI", type: "function", stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ type: "string" }] },
];

function buildAgentCard(agentId) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "VERITY",
    description:
      "Fact-checking agent with persistent memory — VERITY remembers prior claims your agent has checked and skips repeat lookups, saving tokens across sessions. Returns structured verdicts (CURRENT / OUTDATED / DISPUTED / UNVERIFIABLE) with confidence scores, what-changed tracking, and supporting sources. Verifies claims, URLs, and content against live web sources. Protocols: A2A + x402 + MCP.",
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
    pinataMetadata: { name: `verity-erc8004-${card.registrations[0].agentId}-v2.json` },
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
  if (!pk) { console.error("OWNER_PRIVATE_KEY required"); process.exit(1); }
  if (!jwt) { console.error("PINATA_JWT required"); process.exit(1); }

  const account = privateKeyToAccount(pk);
  const publicClient = createPublicClient({ chain: base, transport: http() });
  const walletClient = createWalletClient({ account, chain: base, transport: http() });

  console.log(`\nWallet:  ${account.address}`);
  console.log(`Agent:   ${AGENT_ID}\n`);

  const owner = await publicClient.readContract({
    address: REGISTRY, abi: ABI, functionName: "ownerOf", args: [AGENT_ID],
  });
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    console.error(`❌ Wallet doesn't own agent ${AGENT_ID}. Owner: ${owner}`);
    process.exit(1);
  }
  console.log(`✅ Ownership confirmed (${owner})`);

  const currentURI = await publicClient.readContract({
    address: REGISTRY, abi: ABI, functionName: "tokenURI", args: [AGENT_ID],
  });
  console.log(`Current URI: ${currentURI}\n`);

  console.log("Uploading new card to IPFS via Pinata...");
  const card = buildAgentCard(AGENT_ID);
  const cid = await uploadToIPFS(card, jwt);
  const newURI = `ipfs://${cid}`;
  console.log(`✅ Pinned: ${newURI}`);
  console.log(`   Gateway: https://gateway.pinata.cloud/ipfs/${cid}\n`);

  console.log("Calling setAgentURI...");
  const hash = await walletClient.writeContract({
    address: REGISTRY, abi: ABI, functionName: "setAgentURI", args: [AGENT_ID, newURI],
  });
  console.log(`   tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`✅ Confirmed in block ${receipt.blockNumber}\n`);

  const finalURI = await publicClient.readContract({
    address: REGISTRY, abi: ABI, functionName: "tokenURI", args: [AGENT_ID],
  });
  console.log(`${"─".repeat(60)}`);
  console.log(`✅ VERITY metadata updated on-chain`);
  console.log(`   New URI: ${finalURI}`);
  console.log(`   8004scan: https://8004scan.io/agents/base/${AGENT_ID}?tab=metadata`);
  console.log(`${"─".repeat(60)}\n`);
}

main().catch(e => { console.error(`Fatal: ${e.message}`); process.exit(1); });
