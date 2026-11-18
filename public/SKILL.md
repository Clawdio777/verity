# VERITY: Real-Time Fact-Checking Agent

Version 1.2.1

VERITY verifies claims, URLs, and content against live sources and returns a structured verdict with quoted sources. It searches Tavily, Perplexity, Wikipedia and Semantic Scholar, and every quote is re-fetched from its page before it counts. When the evidence does not settle a claim, VERITY answers UNVERIFIABLE rather than guess. A check usually takes about 20 seconds.

## Endpoint

```
POST https://verity.basechainlabs.com/api/verify
Authorization: x402 (USDC on Base)
```

## Input

```json
{
  "claim": "Pluto is the ninth planet of the Solar System",
  "caller_id": "your-agent-id",
  "no_memory": false
}
```

`caller_id` is optional and turns on memory per caller. `no_memory: true` runs a fresh check that neither reads nor writes caller memory.

## Output (VerityResult)

Example shape (values are illustrative):

```json
{
  "verdict": "OUTDATED",
  "confidence": 90,
  "summary": "Pluto was called the ninth planet until 2006, when it was reclassified as a dwarf planet.",
  "what_changed": "In August 2006 the International Astronomical Union reclassified Pluto as a dwarf planet.",
  "recommendation": "Describe Pluto as a dwarf planet.",
  "downgraded_from": null,
  "downgrade_reason": null,
  "evidence_summary": {
    "verified_quotes": 2,
    "unverified_quotes": 0,
    "independent_organisations": 2,
    "primary_source": true,
    "newest_source_date": null
  },
  "sources": [
    {
      "url": "https://www.iau.org/...",
      "title": "...",
      "published_date": null,
      "quote": "(exact sentence copied from the page)",
      "stance": "SUPERSEDES",
      "organisation": "iau.org",
      "primary": true
    },
    {
      "url": "https://en.wikipedia.org/wiki/Pluto",
      "title": "Pluto",
      "published_date": null,
      "quote": "(exact sentence copied from the page)",
      "stance": "SUPERSEDES",
      "organisation": "wikipedia.org",
      "primary": false
    }
  ],
  "unverified_quotes": [],
  "escalation_rounds": 0,
  "tools_used": ["retrieveCallerMemory", "lookupWikipedia", "searchClaim", "searchForUpdates"],
  "checked_at": "2026-11-18T09:00:00.000Z"
}
```

- `stance` is one of `SUPPORTS` (true now), `REFUTES` (false), `SUPERSEDES` (it changed: renamed, replaced, retired) or `HISTORICAL` (true in the past, without saying it still is).
- `what_changed` is filled only when the verdict is `OUTDATED`; otherwise it is `null`.
- `downgraded_from` shows the first draft verdict when the verified evidence could not support it, with `downgrade_reason`.
- `unverified_quotes` lists quotes that could not be found on their page. They do not count.
- For `UNVERIFIABLE`, the result can include a `searched` log of what was looked for.

## Verdicts

| Verdict | Meaning |
|---|---|
| `CURRENT` | The claim is accurate now |
| `OUTDATED` | The claim was true, but has since changed, been renamed or retired |
| `DISPUTED` | Credible sources say it is false (including claims that were never true), or credible sources conflict |
| `UNVERIFIABLE` | VERITY can't quote one official source or two independent organisations that settle it, or the claim is about the future, private or unknowable |

## Evidence bar

- Every verdict except `UNVERIFIABLE` rests on exact sentences quoted from pages. Code re-fetches every page and drops any quote it can't find there.
- `CURRENT` or `OUTDATED` needs one official source (government, standards body, university, the paper itself, or the organisation the claim is about) or two independent organisations. The same text syndicated on several sites counts once.
- If verified quotes point both ways, the verdict is `DISPUTED`.
- If the evidence is thin, VERITY searches again before deciding.

## Confidence

`confidence` is a label for the strength of the verified evidence, not a probability:

| confidence | evidence behind the verdict |
|---|---|
| 90 | an official source plus at least one more independent organisation |
| 80 | an official source |
| 75 | three or more independent organisations, none official |
| 65 | two independent organisations, none official |
| 40 | one non-official source (only possible for `DISPUTED`) |
| 0 | `UNVERIFIABLE` |

## Accuracy

On 40 claims held back from tuning (18/11/2026), VERITY got 39 right, and none of its CURRENT or OUTDATED verdicts were wrong across 100 test claims.

## Endpoints & Pricing

| Endpoint | Description | Price |
|---|---|---|
| `POST /api/verify` | Standard claim verification | 0.10 USDC |
| `POST /api/deep-check` | Deeper search and more source types for high-stakes claims. Confidence still depends on the evidence found | 0.50 USDC |
| `POST /api/batch-verify` | Verify up to 10 claims at once | 0.75 USDC |
| `POST /api/agent` | Natural language fact-check | 0.10 USDC |

## When to call VERITY

- Before publishing AI-generated content
- When your RAG pipeline sources might be stale
- To detect hallucinations in agent outputs
- To audit articles for outdated facts
- Before trusting a claim in an automated workflow

## Persistent Memory

Pass a consistent `caller_id` (your agent ID, domain, or user hash) on every call. VERITY remembers topics you've checked, domains you monitor, and previous results, so you don't re-send context. Memory is not evidence: each verdict rests on sources checked in that call. Pass `no_memory: true` for a fresh check.

## A2A Agent Card

```
GET https://verity.basechainlabs.com/api/agent?agent-card=true
```

## MCP (Claude Desktop / Cursor)

The hosted MCP endpoint is paid with an API key from a card credit purchase (https://verity.basechainlabs.com/#get-access). To pay in USDC on Base, run the npm package locally so your wallet key never leaves your machine. Never send a wallet private key to any hosted service.

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
