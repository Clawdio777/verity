import { describe, expect, test } from "bun:test";
import { findTokenBalance } from "../sweep-balance.mjs";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

// Real `acp wallet balance --chain-id 8453` output, 22/10/2026 (no NETWORK column)
const now = [
  "TOKEN\tNAME\tBALANCE\tUSD\tCONTRACT",
  "ETH\tEther\t0.00151797\t$3.71\tnative",
  "∪ꓢƊС\t∪ՏƊС\t0\t$0.00\t0x1c8fe660a949db82254e05b059103b9d69d88696",
  "USDC\tUSD Coin\t7.091617\t$7.09\t0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "GOP\tGOP\t10\t$0.00\t0xf3255f7c06ce5dd6711220b6ef890df61d1e7222",
].join("\n");

// Format seen 10/10/2026 (NETWORK column first)
const withNetwork = [
  "NETWORK\tTOKEN\tNAME\tBALANCE\tUSD\tCONTRACT",
  "base\tUSDC\tUSD Coin\t36.02\t$36.02\t0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base\tUSDC\tUSD Coin\t999\t$0.00\t0x22155954428ba4077c0c878715ac5e3be1518dcd",
].join("\n");

describe("findTokenBalance", () => {
  test("reads the current 5-column format", () => {
    expect(findTokenBalance(now, USDC)).toBe(7.091617);
  });
  test("reads the older format with a NETWORK column", () => {
    expect(findTokenBalance(withNetwork, USDC)).toBe(36.02);
  });
  test("ignores look-alike USDC spam tokens", () => {
    expect(findTokenBalance(withNetwork.split("\n").filter(l => !l.includes("36.02")).join("\n"), USDC)).toBeNull();
  });
  test("returns null when there is no header", () => {
    expect(findTokenBalance("Error: not logged in", USDC)).toBeNull();
  });
});
