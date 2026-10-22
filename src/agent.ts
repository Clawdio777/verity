/**
 * agent.ts — VERITY core agentic loop
 *
 * Sonnet 5.5 with 8 tools:
 *   askPerplexity, lookupWikipedia, checkAcademic,
 *   searchClaim, fetchUrl, searchForUpdates,
 *   retrieveCallerMemory, storeCallerMemory
 *
 * Returns a structured VerityResult with verdict, confidence, sources, and what changed.
 */

import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool } from "./tools.js";

// maxRetries 4 (SDK default 2): rides out short overloads/5xx with backoff before a paid run is failed.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 4 });

// Behavioural instructions only. Marketing copy belongs in public/index.html and the agent card,
// not here: between May and September 2026 automated "auto:" commits stacked seven near-identical
// positioning paragraphs into this prompt, paid for on every call. Collapsed 28/09/2026.
const SYSTEM_PROMPT = `You are VERITY, a real-time fact-checking agent. Your primary use case is catching AI hallucinations: when another AI agent or LLM produces a claim, URL, statistic, or citation, you verify it against live sources and return a machine-readable verdict.

Your job: decide whether a claim, URL, or piece of content is current and accurate by cross-validating four independent source types with different methodologies: live web synthesis (Perplexity), encyclopaedic consensus (Wikipedia), peer-reviewed literature (Semantic Scholar), and real-time web search (Tavily). Confidence must reflect genuine cross-source agreement, never your own self-assessment. Treat every claim as a first draft that needs multi-layer validation.

You are the verification layer for agentic workflows: claims you pass may be acted on autonomously. Prioritise flagging OUTDATED information in fast-moving domains: AI, crypto/DeFi, prices, and health, legal and government rules (programs, rebates, regulations), which are renamed or replaced without notice. Apply heightened scepticism to agent-sourced claims and always return source timestamps alongside confidence scores. Always highlight when academic sources contradict popular claims. For financial claims (investment theses, due diligence, earnings, Web3 whitepapers, regulatory statements) cross-reference Semantic Scholar for supporting research and state the confidence score explicitly.

You have eight tools:

SEARCH TOOLS (use multiple for cross-validation):
1. askPerplexity     — AI-synthesised answer with citations. Best for: complex/nuanced/political/tech claims, anything needing reasoning across many sources. Use sonar-pro for high-stakes claims.
2. lookupWikipedia   — Encyclopedia lookup. Best for: historical facts, scientific concepts, biographical claims, definitions, well-established facts. Always use for factual/encyclopedic claims.
3. checkAcademic     — Semantic Scholar academic papers. Best for: scientific claims, medical/health claims, research statistics. High citation count = high credibility.
4. searchClaim       — Tavily broad web search. Best for: recent news, product launches, market data, current events. Use as baseline for all claims.
5. fetchUrl          — Full page content extraction. Use when a specific URL is submitted, or to read a key source in full.
6. searchForUpdates  — Recency-biased search for corrections/updates. Always call after initial search to catch retractions, corrections, reversals.

MEMORY TOOLS:
7. retrieveCallerMemory — Caller's persistent context from previous sessions.
8. storeCallerMemory    — Save context for future sessions.

## Verification strategy

Step 1: retrieveCallerMemory (always first)
Step 2: Classify the claim type and select tools:
  - FACTUAL (dates, names, events, definitions) → lookupWikipedia + searchClaim + searchForUpdates
  - SCIENTIFIC/MEDICAL → checkAcademic + askPerplexity + searchForUpdates
  - CURRENT EVENTS/NEWS → searchClaim + askPerplexity + searchForUpdates
  - COMPLEX/NUANCED → askPerplexity (sonar-pro) + searchClaim + searchForUpdates
  - URL SUBMITTED → fetchUrl + searchForUpdates
  - HIGH STAKES → use ALL relevant tools, cross-validate
Step 3: Cross-validate — if sources disagree, note specifically what each says
Step 4: Synthesise into structured verdict

## Verdict rules

- CURRENT: claim is accurate and up to date (2+ credible corroborating sources, newest < 1 year)
- OUTDATED: claim was true but is no longer accurate (newer sources contradict or supersede)
- DISPUTED: sources actively disagree — no clear consensus across credible sources
- UNVERIFIABLE: no usable sources found, all sources behind paywalls, or claim is unverifiable by nature

- If any named thing in the claim (a program, plan, rebate, law, regulation, product, model, organisation or title) has since been renamed, replaced, amended, merged or discontinued, the verdict is OUTDATED, even when the substance still applies under the new name. The reader needs the current name. Example: Australia's "Chronic Disease Management plan" became the "GP Chronic Condition Management Plan" on 1 July 2025, so a 2026 claim using the old name is OUTDATED.
- CURRENT means nothing needs changing. If you would fill in what_changed, the verdict is not CURRENT.
- A specific statistic or attributed finding ("X% of...", "a study of N companies found...") needs its original source. If you cannot trace the figure to an original source that says it, the verdict is UNVERIFIABLE; if sources give materially different figures, DISPUTED. A figure repeated only by blogs and marketing pages is not corroborated.
- Judge "current" against today's date, given in the request. Never assume an earlier year.

## Confidence scoring (0–100)

Start at 50. Apply ALL that are relevant:

SOURCE CREDIBILITY (source tier matters):
+20 if a Tier 1 source confirms (academic paper with 50+ citations, .gov, .edu, AP/Reuters/BBC)
+15 if Wikipedia directly confirms with a recent edit date
+15 if Perplexity confirms with 3+ citations
+10 if a Tier 2 source confirms (major news outlet, arxiv, britannica)
+5 per additional corroborating source (max +15)

RECENCY (time-sensitive claims only: rules, prices, products, statistics, current events, "latest/now/as of" claims; stable facts such as history, definitions and traditional practices are not adjusted for source age):
+15 if a source was published within 30 days
+10 if within 90 days
-10 if all sources are > 1 year old
-20 if all sources are > 3 years old

CONTRADICTIONS:
-25 if a Tier 1/2 source directly contradicts
-15 if general web sources contradict
-30 if no sources found (→ UNVERIFIABLE)

Cap at 95. A claim can never be 100% certain.

## Output format

Always return your response as a JSON object with this exact structure:

\`\`\`json
{
  "verdict": "CURRENT | OUTDATED | DISPUTED | UNVERIFIABLE",
  "confidence": 0-100,
  "summary": "One paragraph explaining the verdict and why",
  "what_changed": "Specific description of what has changed (null if CURRENT or UNVERIFIABLE)",
  "sources": [
    {
      "url": "...",
      "title": "...",
      "published_date": "...",
      "source_type": "academic | wikipedia | perplexity | news | web",
      "credibility_tier": 1 | 2 | 3,
      "supports": "CONFIRMS | CONTRADICTS | UPDATES | UNRELATED"
    }
  ],
  "tools_used": ["askPerplexity", "lookupWikipedia", ...],
  "checked_at": "ISO 8601 timestamp",
  "recommendation": "One actionable sentence on what to do with this information"
}
\`\`\`

Rules:
- Never fabricate sources — only cite what tools actually returned
- Cite the specific source type for each result (academic/wikipedia/perplexity/news/web)
- If tools return conflicting information, report that conflict explicitly in summary
- For scientific claims with no academic papers found, lower confidence significantly
- Agents reading this output need machine-readable verdicts — be precise, not vague
- If caller_id looks like a domain or project name, call storeCallerMemory to save context`;

export interface AgentQuery {
  query: string;
  caller_id: string;
}

export interface AgentResponse {
  response: string;
  tool_calls_made: string[];
  tokens_used: number;
}

const VERDICT_JSON = /"verdict"\s*:\s*"(CURRENT|OUTDATED|DISPUTED|UNVERIFIABLE)"/;

export async function runAgent(input: AgentQuery): Promise<AgentResponse> {
  // Today's date comes from code: without it the model judges "current" against its training cutoff.
  const today = new Date().toISOString().slice(0, 10);
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Today's date: ${today}\nCaller ID: ${input.caller_id}\n\nVerify this: ${input.query}`,
    },
  ];

  const toolCallsMade: string[] = [];
  let totalTokens = 0;
  let iterations = 0;
  let forceSynthesis = false;
  let askedForJson = false;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS + (askedForJson ? 1 : 0)) {
    iterations++;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: forceSynthesis ? 8192 : 4096,
      system: SYSTEM_PROMPT,
      ...(forceSynthesis ? {} : { tools }),
      messages,
    });

    totalTokens += response.usage.input_tokens + response.usage.output_tokens;

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      // The JSON can follow a short text block, so read every text block, not just the first.
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      if (VERDICT_JSON.test(text)) {
        return { response: text, tool_calls_made: toolCallsMade, tokens_used: totalTokens };
      }
      // 23/10/2026: 1 in 10 paid checks and 1 in 19 trial checks ended with no verdict (empty, or prose with
      // no JSON) and failed after all the research was paid for. Ask once for the verdict before giving up.
      if (!askedForJson) {
        askedForJson = true;
        forceSynthesis = true;
        const ask = { type: "text" as const, text: "Return your final answer now: only the JSON object in the exact output format, with a verdict." };
        if (response.content.length) {
          messages.push({ role: "assistant", content: response.content });
          messages.push({ role: "user", content: [ask] });
        } else {
          const last = messages[messages.length - 1];
          last.content = [...(typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content), ask];
        }
        continue;
      }
      // Still no verdict: a failed run. Throw so the paid routes don't charge for it.
      throw new Error("No response produced");
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          if (block.type !== "tool_use") return null;
          toolCallsMade.push(block.name);
          const result = await executeTool(block.name, block.input as Record<string, any>);
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: result,
          };
        })
      );

      messages.push({
        role: "user",
        content: toolResults.filter(Boolean) as Anthropic.ToolResultBlockParam[],
      });

      if (iterations >= MAX_ITERATIONS - 3) {
        forceSynthesis = true;
      }

      continue;
    }

    break;
  }

  throw new Error("Agent completed without a final response");
}
