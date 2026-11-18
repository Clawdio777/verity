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
import { assessAnswer, buildResult, defaultFetcher, parseModelJson, readEvidence, type Assessment, type EvidenceItem, type PageFetcher, type Verdict } from "./evidence.js";
import { ESCALATION, escalationPrompt, SearchRecorder, shouldEscalate } from "./escalation.js";

// maxRetries 4 (SDK default 2): rides out short overloads/5xx with backoff before a paid run is failed.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 4 });

// Behavioural instructions only. Marketing copy belongs in public/index.html and the agent card,
// not here: between May and September 2026 automated "auto:" commits stacked seven near-identical
// positioning paragraphs into this prompt, paid for on every call. Collapsed 28/09/2026.
const SYSTEM_PROMPT = `You are VERITY, a real-time fact-checking agent. Your primary use case is catching AI hallucinations: when another AI agent or LLM produces a claim, URL, statistic, or citation, you verify it against live sources and return a machine-readable verdict.

Your job: decide whether a claim, URL, or piece of content is current and accurate by cross-validating four independent source types with different methodologies: live web synthesis (Perplexity), encyclopaedic consensus (Wikipedia), peer-reviewed literature (Semantic Scholar), and real-time web search (Tavily). Your own knowledge is never evidence: every verdict rests on sentences you quote from pages the tools returned. Treat every claim as a first draft that needs multi-layer validation.

You are the verification layer for agentic workflows: claims you pass may be acted on autonomously. Prioritise flagging OUTDATED information in fast-moving domains: AI, crypto/DeFi, prices, and health, legal and government rules (programs, rebates, regulations), which are renamed or replaced without notice. Apply heightened scepticism to agent-sourced claims and always return source dates. Always highlight when academic sources contradict popular claims. For financial claims (investment theses, due diligence, earnings, Web3 whitepapers, regulatory statements) cross-reference Semantic Scholar for supporting research.

You have eight tools:

SEARCH TOOLS (use multiple for cross-validation):
1. askPerplexity     — AI-synthesised answer with citations. Best for: complex/nuanced/political/tech claims, anything needing reasoning across many sources. Use sonar-pro for high-stakes claims.
2. lookupWikipedia   — Encyclopedia lookup. Best for: historical facts, scientific concepts, biographical claims, definitions, well-established facts. Always use for factual/encyclopedic claims.
3. checkAcademic     — Semantic Scholar academic papers. Best for: scientific claims, medical/health claims, research statistics. High citation count = high credibility.
4. searchClaim       — Tavily broad web search. Best for: recent news, product launches, market data, current events. Use as baseline for all claims. Results marked official_source come first: prefer them.
5. fetchUrl          — Full page content extraction. Use when a specific URL is submitted, or to read a key source in full. Pass find="phrase" to get the passages of a long page that mention it, so you can quote the exact sentence.
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
  - ABOUT A COMPANY, PRODUCT, POLICY OR STUDY → find and fetchUrl the official page (the company's own documentation, the government page, the paper itself) and quote it; secondary write-ups are leads, not proof
  - HIGH STAKES → use ALL relevant tools, cross-validate
Step 3: Cross-validate — if sources disagree, note specifically what each says
Step 4: Synthesise into structured verdict

## Verdict rules

- CURRENT: the claim is accurate now.
- OUTDATED: the claim was once accurate and has since been superseded, renamed, retired or changed. Only for claims that WERE true.
- DISPUTED: credible sources contradict the claim (including claims that were never true), or credible sources disagree with each other.
- UNVERIFIABLE: you cannot quote sources that settle it: no usable sources, the claim is about the future, private, or unknowable, or the evidence is too thin.

- If any named thing in the claim (a program, plan, rebate, law, regulation, product, model, organisation or title) has since been renamed, replaced, amended, merged or discontinued, the verdict is OUTDATED, even when the substance still applies under the new name. The reader needs the current name. Example: Australia's "Chronic Disease Management plan" became the "GP Chronic Condition Management Plan" on 1 July 2025, so a 2026 claim using the old name is OUTDATED.
- CURRENT means nothing needs changing. If you would fill in what_changed, the verdict is not CURRENT.
- A specific statistic or attributed finding ("X% of...", "a study of N companies found...") needs its original source. If you cannot trace the figure to an original source that says it, the verdict is UNVERIFIABLE; if sources give materially different figures, DISPUTED. A figure repeated only by blogs and marketing pages is not corroborated.
- Judge "current" against today's date, given in the request. Never assume an earlier year.
- When unsure, or when the evidence you can quote does not settle the claim, answer UNVERIFIABLE (or DISPUTED if sources conflict). Never guess. A wrong CURRENT or OUTDATED is far worse than an UNVERIFIABLE.
- If the search tools fail or return nothing usable, the verdict is UNVERIFIABLE. Do not fill the gap from memory.

## Evidence rules (checked by code after you answer)

- Every verdict except UNVERIFIABLE needs "evidence": exact sentences copied character for character from text a tool returned (a search result's content, a fetched page, a Wikipedia summary). One contiguous sentence or clause per item, at least eight words, no ellipses, no paraphrase. Perplexity answers are not quotable evidence: quote the pages it cites instead.
- Code re-fetches every evidence URL and drops any quote it cannot find on that page. Quotes that are not on the page do not count.
- CURRENT or OUTDATED must rest on either one primary/official source (government, standards body, university, the paper itself, or the organisation the claim is about, e.g. Google's own documentation for a claim about Google) or two independent organisations (two pages of the same organisation, or the same text syndicated on several sites, count once). Otherwise code returns UNVERIFIABLE.
- If verified evidence points both ways, code returns DISPUTED. Label each item's stance honestly:
  - SUPPORTS: says the claim is true now
  - REFUTES: says the claim is false
  - SUPERSEDES: shows it changed (renamed, replaced, retired, no longer true), ideally with the date
  - HISTORICAL: confirms it was true in the past, without saying it is still true
- Code sets "confidence" from the verified evidence. Do not output a confidence number.

## Output format

Always return your response as a JSON object with this exact structure:

\`\`\`json
{
  "verdict": "CURRENT | OUTDATED | DISPUTED | UNVERIFIABLE",
  "summary": "One paragraph explaining the verdict and why",
  "what_changed": "Specific description of what has changed, with the date (null unless OUTDATED)",
  "evidence": [
    {
      "url": "the page the quote is on",
      "title": "...",
      "published_date": "YYYY-MM-DD or null",
      "quote": "exact sentence copied from the tool output",
      "stance": "SUPPORTS | REFUTES | SUPERSEDES | HISTORICAL"
    }
  ],
  "tools_used": ["searchClaim", ...],
  "checked_at": "ISO 8601 timestamp",
  "recommendation": "One actionable sentence on what to do with this information"
}
\`\`\`

Rules:
- Never fabricate sources or quotes: only quote what tools actually returned
- If tools return conflicting information, report that conflict explicitly in summary
- Agents reading this output need machine-readable verdicts: be precise, not vague
- If caller_id looks like a domain or project name, call storeCallerMemory to save context`;

export interface AgentQuery {
  query: string;
  caller_id: string;
  /** true: caller memory is neither read nor written for this call (fresh check, nothing cached passed off as new). */
  no_memory?: boolean;
}

export const MEMORY_TOOLS = new Set(["retrieveCallerMemory", "storeCallerMemory"]);

export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Tavily API credits used by this run (search basic = 1, advanced = 2, extract = 1 per 5 URLs). */
  tavily_credits: number;
}

export interface AgentResponse {
  response: string;
  tool_calls_made: string[];
  tokens_used: number;
  usage: AgentUsage;
}

export function tavilyCredits(name: string, input: Record<string, any>): number {
  if (name === "searchClaim") return input?.search_depth === "advanced" ? 2 : 1;
  if (name === "searchForUpdates" || name === "fetchUrl") return 1;
  return 0;
}

const VERDICT_JSON = /"verdict"\s*:\s*"(CURRENT|OUTDATED|DISPUTED|UNVERIFIABLE)"/;

// Tools whose output can count as evidence, and the strings they return when they fail or find nothing.
const EVIDENCE_TOOLS = new Set(["searchClaim", "searchForUpdates", "fetchUrl", "lookupWikipedia", "checkAcademic", "askPerplexity"]);
export const TOOL_FAILED = /^(\w+ error\b|Tavily search error|Could not|Perplexity (not configured|error)|Semantic Scholar error|Wikipedia search error|No results found|No academic papers|No Wikipedia article|No recent updates|Unknown tool)/;

export interface AgentOptions {
  /** Page fetcher for re-checking quotes (tests inject a fake; default: plain fetch, then Tavily Extract). */
  fetcher?: PageFetcher;
}

export async function runAgent(input: AgentQuery, opts: AgentOptions = {}): Promise<AgentResponse> {
  // Today's date comes from code: without it the model judges "current" against its training cutoff.
  const today = new Date().toISOString().slice(0, 10);
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Today's date: ${today}\nCaller ID: ${input.caller_id}\n${input.no_memory ? "Caller memory: OFF for this request. Do not call retrieveCallerMemory or storeCallerMemory.\n" : ""}\nVerify this: ${input.query}`,
    },
  ];

  const toolCallsMade: string[] = [];
  // no_memory: the memory tools are not offered, and a call to one anyway is refused without touching the database.
  const runTools = input.no_memory ? tools.filter((t) => !MEMORY_TOOLS.has(t.name)) : tools;
  let totalTokens = 0;
  const usage: AgentUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, tavily_credits: 0 };
  // Prompt caching: the system prompt and the growing tool history are re-sent every turn, so mark the
  // newest tool-result block as a cache breakpoint (one moving breakpoint plus the system prompt).
  let marked: { cache_control?: unknown } | null = null;
  let evidenceToolsWorked = false;
  let iterations = 0;
  let forceSynthesis = false;
  let askedForJson = false;
  const MAX_ITERATIONS = 10;
  // Turn limits: the first pass may use tools until turn 7 and must answer by turn 10. Each evidence
  // escalation round (src/escalation.ts) moves both limits on by ESCALATION.turnsPerRound.
  let synthesiseAfter = MAX_ITERATIONS - 3;
  let turnLimit = MAX_ITERATIONS;

  // Evidence escalation state: rounds done, evidence so far, the verdict first proposed, the last
  // gated answer (returned as-is if an escalation round fails) and the Tavily credits escalation used.
  let round = 0;
  let prior: EvidenceItem[] = [];
  let firstProposed: Verdict | null = null;
  let lastAssessment: Assessment | null = null;
  let escalationCredits = 0;
  const searches = new SearchRecorder();
  const fetchStats = { tavily_credits: 0 };
  const finish = (a: Assessment): AgentResponse => {
    usage.tavily_credits += fetchStats.tavily_credits;
    searches.addSources(a.items.map((i) => i.url));
    const final = buildResult(a, evidenceToolsWorked, searches.log(round));
    return { response: JSON.stringify(final, null, 2), tool_calls_made: toolCallsMade, tokens_used: totalTokens, usage };
  };

  while (iterations < turnLimit + (askedForJson ? 1 : 0)) {
    iterations++;

    const last = messages[messages.length - 1];
    if (Array.isArray(last.content) && last.content.length) {
      if (marked) delete marked.cache_control;
      marked = last.content[last.content.length - 1] as { cache_control?: unknown };
      marked.cache_control = { type: "ephemeral" };
    }

    let response: Anthropic.Message;
    try {
      response = await anthropic.messages.create({
        model: "claude-sonnet-5-5",
        max_tokens: forceSynthesis ? 8192 : 4096,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        ...(forceSynthesis ? {} : { tools: runTools }),
        messages,
      });
    } catch (e) {
      // An escalation round must never turn a finished check into a failed one.
      if (lastAssessment) return finish(lastAssessment);
      throw e;
    }

    const u = response.usage;
    totalTokens += u.input_tokens + u.output_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    usage.input_tokens += u.input_tokens;
    usage.output_tokens += u.output_tokens;
    usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      // The JSON can follow a short text block, so read every text block, not just the first.
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      if (VERDICT_JSON.test(text)) {
        // The model only proposes. Code re-fetches every quoted source and gates the verdict (src/evidence.ts).
        const fetcher = opts.fetcher ?? defaultFetcher(fetchStats, quotesByUrl(text));
        const a = await assessAnswer(text, input.query, fetcher, { prior, firstProposed });
        if (a) {
          // Thin evidence (not conflicting evidence): search again before abstaining (src/escalation.ts).
          if (shouldEscalate(a, evidenceToolsWorked, round) && escalationCredits < ESCALATION.tavilyCredits) {
            round++;
            prior = a.items;
            firstProposed ??= a.proposed;
            lastAssessment = a;
            messages.push({ role: "assistant", content: response.content });
            messages.push({ role: "user", content: [{ type: "text", text: escalationPrompt(a, round) }] });
            forceSynthesis = false;
            askedForJson = false;
            synthesiseAfter = iterations + ESCALATION.turnsPerRound - 1;
            turnLimit = iterations + ESCALATION.turnsPerRound;
            continue;
          }
          return finish(a);
        }
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
      // Still no verdict. After an escalation round, return the answer from before it; otherwise
      // this is a failed run: throw so the paid routes don't charge for it.
      if (lastAssessment) return finish(lastAssessment);
      throw new Error("No response produced");
    }

    if (response.stop_reason === "tool_use") {
      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      messages.push({ role: "assistant", content: response.content });

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          if (block.type !== "tool_use") return null;
          toolCallsMade.push(block.name);
          if (input.no_memory && MEMORY_TOOLS.has(block.name)) {
            return { type: "tool_result" as const, tool_use_id: block.id, content: "Caller memory is off for this request.", is_error: true };
          }
          const credits = tavilyCredits(block.name, block.input as Record<string, any>);
          if (round > 0) {
            if (escalationCredits + credits > ESCALATION.tavilyCredits) {
              return { type: "tool_result" as const, tool_use_id: block.id, content: "Evidence search budget for this check is used up: return your final JSON answer now.", is_error: true };
            }
            escalationCredits += credits;
          }
          searches.record(block.name, block.input as Record<string, any>);
          usage.tavily_credits += credits;
          const result = await executeTool(block.name, block.input as Record<string, any>);
          const failed = TOOL_FAILED.test(result);
          if (!failed && EVIDENCE_TOOLS.has(block.name)) evidenceToolsWorked = true;
          return {
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: result,
            ...(failed ? { is_error: true } : {}),
          };
        })
      );

      messages.push({
        role: "user",
        content: toolResults.filter(Boolean) as Anthropic.ToolResultBlockParam[],
      });

      if (iterations >= synthesiseAfter || (round > 0 && escalationCredits >= ESCALATION.tavilyCredits)) {
        forceSynthesis = true;
      }

      continue;
    }

    break;
  }

  if (lastAssessment) return finish(lastAssessment);
  throw new Error("Agent completed without a final response");
}

/** url -> quotes from the model's draft, so the fetcher can retry JavaScript-rendered pages via Tavily. */
function quotesByUrl(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of readEvidence(parseModelJson(text)?.evidence)) out.set(e.url, [...(out.get(e.url) ?? []), e.quote]);
  return out;
}
