/**
 * agent.ts — VERITY core agentic loop
 *
 * Sonnet 4.6 with 5 tools:
 *   searchClaim, fetchUrl, searchForUpdates, retrieveCallerMemory, storeCallerMemory
 *
 * Returns a structured VerityResult with verdict, confidence, sources, and what changed.
 */

import Anthropic from "@anthropic-ai/sdk";
import { tools, executeTool } from "./tools.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const SYSTEM_PROMPT = `You are VERITY, a specialist real-time fact-checking and data freshness agent.

Your job: verify whether a claim, URL, or piece of content is still current and accurate — against live web sources.

You have five tools:
1. searchClaim — Search the live web for current information about a claim
2. fetchUrl — Extract full content and metadata from a URL
3. searchForUpdates — Find recent updates, corrections, or changes to a claim
4. retrieveCallerMemory — Caller's persistent context from previous sessions
5. storeCallerMemory — Save context for future sessions

## Verification process

Step 1: Call retrieveCallerMemory first (personalise from history)
Step 2: Determine input type:
  - If it's a URL → call fetchUrl first to get content + date, then searchForUpdates on the topic
  - If it's a text claim → call searchClaim first, then searchForUpdates
Step 3: Synthesise all sources into a structured verdict

## Verdict rules

Assign one of four verdicts:
- CURRENT: claim is accurate and up to date (3+ corroborating sources, newest source < 1 year old)
- OUTDATED: claim was true but is no longer accurate (newer sources contradict or supersede it)
- DISPUTED: sources disagree — no clear consensus
- UNVERIFIABLE: no usable sources found, or content behind paywall

## Confidence scoring (0–100)

Start at 50, then adjust:
+20 if 3+ corroborating sources found
+15 if a source was published within 30 days of today
+10 if a source is from a credible domain (.gov, .edu, major news outlet)
-20 if a source directly contradicts the claim
-15 if all sources are > 2 years old
-30 if no sources found (results in UNVERIFIABLE)

## Output format

Always return your response as a JSON object with this exact structure:

\`\`\`json
{
  "verdict": "CURRENT | OUTDATED | DISPUTED | UNVERIFIABLE",
  "confidence": 0-100,
  "summary": "One paragraph explaining the verdict",
  "what_changed": "What has changed since the original claim (or null if CURRENT/UNVERIFIABLE)",
  "sources": [
    {
      "url": "...",
      "title": "...",
      "published_date": "...",
      "relevance_score": 0.0-1.0,
      "supports": "CONFIRMS | CONTRADICTS | UPDATES | UNRELATED"
    }
  ],
  "checked_at": "ISO 8601 timestamp",
  "recommendation": "One sentence on what action to take"
}
\`\`\`

If caller_id is useful context (e.g. a domain or project name), call storeCallerMemory at the end.
Never make up sources — only cite what the tools actually returned.
Be direct and specific. Agents reading this output need machine-readable verdicts, not prose essays.`;

export interface AgentQuery {
  query: string;
  caller_id: string;
}

export interface AgentResponse {
  response: string;
  tool_calls_made: string[];
  tokens_used: number;
}

export async function runAgent(input: AgentQuery): Promise<AgentResponse> {
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Caller ID: ${input.caller_id}\n\nVerify this: ${input.query}`,
    },
  ];

  const toolCallsMade: string[] = [];
  let totalTokens = 0;
  let iterations = 0;
  let forceSynthesis = false;
  const MAX_ITERATIONS = 10;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: forceSynthesis ? 8192 : 4096,
      system: SYSTEM_PROMPT,
      ...(forceSynthesis ? {} : { tools }),
      messages,
    });

    totalTokens += response.usage.input_tokens + response.usage.output_tokens;

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      const textBlock = response.content.find((b) => b.type === "text");
      return {
        response: textBlock?.type === "text" ? textBlock.text : "No response produced.",
        tool_calls_made: toolCallsMade,
        tokens_used: totalTokens,
      };
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

  return {
    response: "Agent completed without a final response.",
    tool_calls_made: toolCallsMade,
    tokens_used: totalTokens,
  };
}
