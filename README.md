# VERITY — Real-Time Fact-Checking Agent

[![Smithery Badge](https://smithery.ai/badge/clawdio777/verity)](https://smithery.ai/servers/clawdio777/verity)

Real-time fact-checking and data freshness agent. Verifies claims, URLs, and content against live web sources. Returns structured verdicts with confidence scores, what has changed, and supporting sources.

## Verdicts

| Verdict | Meaning |
|---|---|
| `CURRENT` | Claim is accurate and up to date |
| `OUTDATED` | Claim was true but has since been superseded |
| `DISPUTED` | Sources disagree — no clear consensus |
| `UNVERIFIABLE` | No usable sources found |

## MCP Setup (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "verity": {
      "command": "npx",
      "args": ["verity-mcp"],
      "env": {
        "VERITY_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

Get USDC on Base at [coinbase.com/wallet](https://coinbase.com/wallet).

## Tools

| Tool | Description | Price |
|---|---|---|
| `verity_verify` | Verify a claim or URL against live sources | 0.10 USDC |
| `verity_deep_check` | Multi-angle thorough verification | 0.50 USDC |
| `verity_batch` | Verify up to 10 claims at once | 0.75 USDC |
| `verity_agent` | Natural language fact-checking | 0.10 USDC |

## API

```
POST https://verity.basechainlabs.com/api/verify
Authorization: x402 (USDC on Base)
```

```json
{
  "claim": "Is GPT-4 still the most capable OpenAI model?",
  "caller_id": "my-agent-id"
}
```

Response:
```json
{
  "verdict": "OUTDATED",
  "confidence": 91,
  "summary": "GPT-4 has been superseded by GPT-4o and o3.",
  "what_changed": "OpenAI released GPT-4o (May 2024) and o3 (late 2024).",
  "sources": [{ "url": "...", "title": "...", "published_date": "2025-01", "supports": "CONTRADICTS" }],
  "checked_at": "2026-05-11T09:00:00Z",
  "recommendation": "Update any content referencing GPT-4 as the most capable model."
}
```

## Persistent Memory

Pass a consistent `caller_id` on every call. VERITY remembers topics you've checked, domains you monitor, and previous results — no re-sending context.

## A2A Agent Card

```
GET https://verity.basechainlabs.com/api/agent?agent-card=true
```

Built by [BaseChain Labs](https://basechainlabs.com)
