# VERITY — Real-Time Fact-Checking Agent

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
| `check_credits` | Remaining balance for a PayGated `pg_` key | free |

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

---

## Making changes (maintainer guide)

### Where things live

| Thing | Where |
|---|---|
| The agent's brain | `src/agent.ts` (system prompt, orchestration), `src/tools.ts` (fact-checking: Tavily search + Claude verdicts) |
| API endpoints | one file per route under `api/`: `agent` (paid A2A entry), `verify`, `deep-check`, `batch-verify`, `mcp`, `checkout`, `stripe-webhook`, `recover-key`, plus the `cron-check-deps` and `daily-summary` crons |
| Payment gate | `api/_x402-gate.ts`: unpaid POSTs get HTTP 402 with the price and the Bazaar listing; GET returns the agent card |
| Public page | `public/index.html` (plain HTML). Agent card: `public/.well-known/agent.json` |
| Marketplace seller | `seller-v2.mjs` + `Dockerfile` + `railway.json`, the Virtuals ACP seller on Railway. Its keyring lives on a Railway volume; `keyring.json` and `keyring.key` are runtime files and gitignored |
| Secrets | hosting environment variables only. Never in a file, never in a commit |

### How a change goes live

There is no test suite and no CI on this repo. A push to `main` is the deploy.

1. Edit, then type-check: `npx tsc --noEmit -p .`
2. Commit and push to `main`. Vercel builds and deploys production from the GitHub integration.
3. Confirm the newest production deployment carries your commit SHA and the endpoint answers: `curl -s https://verity.basechainlabs.com/.well-known/agent.json | head -c 300`
4. A push also redeploys the Railway seller. Confirm its log shows it connected afterwards.

Because there are no tests, prove a change on the live endpoint with a read-only call before calling it done. Never make a paid call (x402 or Stripe) just to test.

### Things that bite

- Prices live in four places that must stay in sync: `public/index.html`, the 402 body in `api/_x402-gate.ts`, the Virtuals ACP offerings, and the npm package README.
- Agentic.market's "Validate endpoint" tool: use POST. GET returns the agent card (200) by design and the validator then says "no x402 setup".
- Tavily is the search backend. If verifications start failing, check the Tavily credit first.
- Removing the Railway volume wipes the seller's keyring on the next redeploy and takes it offline.
