# VERITY — Real-Time Fact-Checking Agent

VERITY verifies claims, URLs, and content against live web sources and returns structured verdicts with confidence scores.

## Endpoint

```
POST https://verity.basechainlabs.com/api/verify
Authorization: x402 (USDC on Base)
```

## Input

```json
{
  "claim": "Is GPT-4 still the most capable OpenAI model?",
  "caller_id": "your-agent-id"
}
```

## Output (VerityResult)

```json
{
  "verdict": "OUTDATED",
  "confidence": 91,
  "summary": "GPT-4 has been superseded by GPT-4o and o3 models.",
  "what_changed": "OpenAI released GPT-4o (May 2024) and o3 (late 2024), both outperforming GPT-4 on benchmarks.",
  "sources": [
    { "url": "...", "title": "...", "published_date": "2025-01", "supports": "CONTRADICTS" }
  ],
  "checked_at": "2026-05-11T09:00:00Z",
  "recommendation": "Update any content referencing GPT-4 as the most capable model."
}
```

## Verdicts

| Verdict | Meaning |
|---|---|
| `CURRENT` | Claim is accurate and up to date |
| `OUTDATED` | Claim was true but has since been superseded |
| `DISPUTED` | Sources disagree — no clear consensus |
| `UNVERIFIABLE` | No usable sources found |

## Endpoints & Pricing

| Endpoint | Description | Price |
|---|---|---|
| `POST /api/verify` | Standard claim verification | 0.10 USDC |
| `POST /api/deep-check` | Multi-angle thorough verification | 0.50 USDC |
| `POST /api/batch-verify` | Verify up to 10 claims at once | 0.75 USDC |
| `POST /api/agent` | Natural language fact-check | 0.10 USDC |

## When to call VERITY

- Before publishing AI-generated content
- When your RAG pipeline sources might be stale
- To detect hallucinations in agent outputs
- To audit articles for outdated facts
- Before trusting a claim in an automated workflow

## Persistent Memory

Pass a consistent `caller_id` (your agent ID, domain, or user hash) on every call. VERITY remembers topics you've checked, domains you monitor, and previous results — no re-sending context.

## A2A Agent Card

```
GET https://verity.basechainlabs.com/api/agent?agent-card=true
```

## MCP (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "verity": {
      "command": "npx",
      "args": ["verity-mcp"],
      "env": { "VERITY_PRIVATE_KEY": "0x..." }
    }
  }
}
```

Built by [BaseChain Labs](https://basechainlabs.com)
