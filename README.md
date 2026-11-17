# VERITY — Real-Time Fact-Checking Agent

Real-time fact-checking and data freshness agent. Verifies claims, URLs, and content against live web sources. Returns structured verdicts with confidence scores, what has changed, and supporting sources.

## Verdicts

| Verdict | Meaning |
|---|---|
| `CURRENT` | Claim is accurate and up to date |
| `OUTDATED` | Claim was true but has since been superseded, renamed or retired |
| `DISPUTED` | Credible sources contradict the claim (including claims that were never true), or disagree with each other |
| `UNVERIFIABLE` | VERITY could not settle it with quoted sources: treat as "do not rely on this" |

### How a verdict is checked

The model only proposes a verdict. Code then checks it (`src/evidence.ts`):

1. Every source must come with an exact sentence quoted from it. VERITY re-fetches each page and confirms the sentence is really there (whitespace, case, quote marks and dashes normalised). Quotes it cannot find are dropped and listed under `unverified_quotes`.
2. `CURRENT` and `OUTDATED` need one primary/official source (government, standards body, university, the study itself, or the organisation the claim is about) or two independent organisations. Government sites count by domain (`.gov`, `.gov.au`, `.gc.ca`, `europa.eu`, department sites under `gov.xx` / `gouv.xx` / `gob.xx`, and a short list of national sites such as `bundesregierung.de`), plus a fixed list of standards and authoritative bodies (e.g. IETF, ISO, CTBUH for building heights). Pages of one organisation, and the same sentence syndicated on several sites, count once. Otherwise the verdict becomes `UNVERIFIABLE`.
3. Verified evidence on both sides turns the verdict into `DISPUTED`. `OUTDATED` needs a verified quote showing the change.
4. If the search and fetch tools failed, the verdict is `UNVERIFIABLE`: VERITY never answers from the model's memory.

When the check changes the model's verdict, `downgraded_from` and `downgrade_reason` say why.

### Evidence escalation

A verdict that fails step 2 only because the evidence is thin (not because sources conflict) is not dropped straight away. VERITY tells the model exactly what counted and what did not, and runs up to 2 more search rounds aimed at (a) the authoritative body for the claim's domain (the government site for an office-holder, CTBUH for building heights, the standards body, the company's own site, the journal) and (b) independent major outlets. Every new quote is re-fetched and the same gate runs again: the bar does not move. Guards (`src/escalation.ts`):

- Evidence is cumulative: nothing found earlier can be dropped, and re-quoting an earlier sentence with a different stance does not count.
- Contradicting evidence found while escalating makes the verdict `DISPUTED`.
- Switching between `CURRENT` and `OUTDATED` while escalating makes it `UNVERIFIABLE`.
- Caps per claim: 2 rounds, 3 model turns per round, 8 Tavily credits in total. If an escalation round fails, the answer from before it is returned (the check never fails because of escalation).

`escalation_rounds` says how many rounds ran. An `UNVERIFIABLE` verdict also carries `searched`: the queries and domains VERITY tried.

### Confidence

`confidence` is a label for the strength of the verified evidence, not a probability and not the model's opinion:

| confidence | evidence behind the verdict |
|---|---|
| 90 | a primary/official source plus at least one more independent organisation |
| 80 | a primary/official source |
| 75 | three or more independent organisations, none primary |
| 65 | two independent organisations, none primary |
| 40 | one non-primary source (only possible for `DISPUTED`) |
| 0 | `UNVERIFIABLE` |

The facts it is derived from are in `evidence_summary`: `verified_quotes`, `unverified_quotes`, `independent_organisations`, `primary_source`, `newest_source_date`.

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

Response (the `text` part of the artifact):
```json
{
  "verdict": "OUTDATED",
  "confidence": 80,
  "summary": "Pluto was reclassified as a dwarf planet by the IAU in 2006.",
  "what_changed": "On 24 August 2006 the IAU reclassified Pluto as a dwarf planet.",
  "sources": [{ "url": "https://...", "quote": "exact sentence from the page", "stance": "SUPERSEDES", "organisation": "iau.org", "primary": true, "published_date": "2006-08-24" }],
  "evidence_summary": { "verified_quotes": 2, "unverified_quotes": 0, "independent_organisations": 2, "primary_source": true, "newest_source_date": "2024-05-01" },
  "downgraded_from": null,
  "downgrade_reason": null,
  "unverified_quotes": [],
  "escalation_rounds": 0,
  "checked_at": "2026-11-17T09:00:00Z",
  "recommendation": "Refer to Pluto as a dwarf planet."
}
```

## Persistent Memory

Pass a consistent `caller_id` on every call. VERITY remembers topics you've checked, domains you monitor, and previous results — no re-sending context.

To get a fresh check with no memory at all, send `"no_memory": true` in the request body (`/api/verify`, `/api/deep-check`, `/api/batch-verify`, `/api/agent`; for JSON-RPC put it in `params`; in the MCP tools it is a tool argument). VERITY then neither reads nor writes caller memory for that call: the memory tools are not offered to the model, and a memory call is refused without touching the database. Only the boolean `true` turns it on. Your `caller_id` is still used for logging.

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

### Accuracy benchmark

`test/benchmark/claims.json` holds 100 labelled claims (true, false, outdated, unverifiable, and AEO/GEO claims including common myths), each with its expected verdict, the reason, and a primary source URL plus the exact sentence that proves the label. 60 are `dev`, 40 are `heldout`: tune only on dev.

- `bun test`: offline checks, including the claims file and the scorer (free).
- `bun run benchmark:check-sources`: re-checks every label's source sentence on the live page.
- `bun run benchmark --split dev --label <name>`: runs the real verify logic locally on the dev set. Caller memory is switched off and no route or payment code runs. Spend (Anthropic tokens + Tavily credits) is logged to `test/benchmark/results/ledger.jsonl` and the run stops before `BENCH_BUDGET_USD` (default 10). Needs `ANTHROPIC_API_KEY` and `TAVILY_API_KEY` in the environment.
- `bun run benchmark:smoke`: five dev claims, about US$0.30.
- Held-out: `bun run benchmark --split heldout --label <name> --final`. Run it once per change you want to report, never to tune.

The headline number is the wrong-confident rate: of the `CURRENT`/`OUTDATED` verdicts, how many were wrong. Next to it, missed facts: `UNVERIFIABLE` on a claim whose label is `CURRENT`, `OUTDATED` or `DISPUTED` (target 0). Results are in `test/benchmark/results/*.md`.

### Things that bite

- Prices live in four places that must stay in sync: `public/index.html`, the 402 body in `api/_x402-gate.ts`, the Virtuals ACP offerings, and the npm package README.
- Agentic.market's "Validate endpoint" tool: use POST. GET returns the agent card (200) by design and the validator then says "no x402 setup".
- Tavily is the search backend. If verifications start failing, check the Tavily credit first.
- Removing the Railway volume wipes the seller's keyring on the next redeploy and takes it offline.
