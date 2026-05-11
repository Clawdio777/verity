/**
 * tools.ts — VERITY: 5 core tools
 *
 * 1. searchClaim      — Tavily search for current info on a claim/topic
 * 2. fetchUrl         — Tavily Extract to get page content + publication date
 * 3. searchForUpdates — Recency-biased search to find what has changed
 * 4. retrieveCallerMemory — Caller-specific persistent context
 * 5. storeCallerMemory    — Save new context for this caller
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const db = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const TAVILY_API_KEY = process.env.TAVILY_API_KEY!;

// ── Tool definitions ───────────────────────────────────────────────────────────

export const tools: Anthropic.Tool[] = [
  {
    name: "searchClaim",
    description:
      "Search the live web for current information about a claim, fact, or topic. " +
      "Returns recent sources with titles, URLs, content snippets, and publication dates. " +
      "Use this as the first step for any claim verification. " +
      "Set search_depth to 'advanced' for deep-check requests.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The claim or topic to search for. Be specific. E.g. 'OpenAI GPT-5 release date 2026'",
        },
        max_results: {
          type: "number",
          description: "Number of results to return. Default 5, max 10.",
        },
        search_depth: {
          type: "string",
          enum: ["basic", "advanced"],
          description: "'basic' for standard verify (fast), 'advanced' for deep-check (thorough). Default: basic",
        },
      },
      required: ["query"],
    },
  },

  {
    name: "fetchUrl",
    description:
      "Fetch and extract the full text content of a URL, including publication date and last-modified info. " +
      "Use when the caller submits a URL to check freshness, or when you need to verify the full content of a specific source. " +
      "Returns the page text and metadata.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The full URL to fetch and extract. Must start with http:// or https://",
        },
      },
      required: ["url"],
    },
  },

  {
    name: "searchForUpdates",
    description:
      "Search specifically for recent updates, corrections, or changes to a claim. " +
      "Uses recency-biased search to find what has changed since the original claim was made. " +
      "Returns sources that confirm, contradict, or update the original claim. " +
      "Always call this after searchClaim to detect outdated information.",
    input_schema: {
      type: "object" as const,
      properties: {
        original_claim: {
          type: "string",
          description: "The original claim or fact to check for updates",
        },
        original_date: {
          type: "string",
          description: "Approximate date the claim was made (e.g. '2024-03'). Used to find newer info.",
        },
      },
      required: ["original_claim"],
    },
  },

  {
    name: "retrieveCallerMemory",
    description:
      "Retrieve this caller's persistent memory: URLs they've checked before, domains they monitor, " +
      "topics of interest, and any context from previous verification sessions. " +
      "Always call this first to personalise the response.",
    input_schema: {
      type: "object" as const,
      properties: {
        caller_id: {
          type: "string",
          description: "Stable caller identifier",
        },
      },
      required: ["caller_id"],
    },
  },

  {
    name: "storeCallerMemory",
    description:
      "Save context for this caller. Call when you learn their domain, topics of interest, " +
      "or any useful context. This persists across all future verification requests from this caller.",
    input_schema: {
      type: "object" as const,
      properties: {
        caller_id: {
          type: "string",
          description: "Stable caller identifier",
        },
        updates: {
          type: "object",
          description:
            "Fields to update. Any/all of: domains_monitored (array), topics (array), context (object)",
        },
      },
      required: ["caller_id", "updates"],
    },
  },
];

// ── Tool executors ─────────────────────────────────────────────────────────────

export async function executeTool(
  name: string,
  input: Record<string, any>
): Promise<string> {
  switch (name) {
    case "searchClaim":       return await runSearchClaim(input);
    case "fetchUrl":          return await runFetchUrl(input);
    case "searchForUpdates":  return await runSearchForUpdates(input);
    case "retrieveCallerMemory": return await runRetrieveCallerMemory(input);
    case "storeCallerMemory":    return await runStoreCallerMemory(input);
    default: return `Unknown tool: ${name}`;
  }
}

// ── Tavily Search ──────────────────────────────────────────────────────────────

async function runSearchClaim(input: Record<string, any>): Promise<string> {
  const { query, max_results = 5, search_depth = "basic" } = input;

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        max_results: Math.min(max_results, 10),
        search_depth,
        include_answer: false,
        include_raw_content: false,
        include_domains: [],
        exclude_domains: [],
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) return `Tavily search error: ${res.status} ${await res.text()}`;

    const data = await res.json() as {
      results?: { url: string; title: string; content: string; published_date?: string; score?: number }[];
    };

    if (!data.results?.length) return "No results found for this claim.";

    return JSON.stringify(data.results.map(r => ({
      url: r.url,
      title: r.title,
      content: r.content?.substring(0, 500),
      published_date: r.published_date,
      relevance_score: r.score,
    })), null, 2);
  } catch (e: any) {
    return `searchClaim error: ${e.message}`;
  }
}

// ── Tavily Extract ─────────────────────────────────────────────────────────────

async function runFetchUrl(input: Record<string, any>): Promise<string> {
  const { url } = input;

  try {
    const res = await fetch("https://api.tavily.com/extract", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({ urls: [url] }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      // Fall back to native fetch
      return await fallbackFetch(url);
    }

    const data = await res.json() as {
      results?: { url: string; raw_content?: string; title?: string }[];
      failed_results?: { url: string; error: string }[];
    };

    if (data.failed_results?.length && !data.results?.length) {
      return await fallbackFetch(url);
    }

    const result = data.results?.[0];
    if (!result) return "Could not extract content from URL.";

    const content = result.raw_content?.substring(0, 3000) || "No content extracted";
    return JSON.stringify({ url: result.url, title: result.title, content }, null, 2);
  } catch (e: any) {
    return await fallbackFetch(url);
  }
}

async function fallbackFetch(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "VERITY-Bot/1.0 (fact-check agent)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return `Could not fetch URL: HTTP ${res.status}`;
    const html = await res.text();
    // Strip tags, take first 2000 chars
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 2000);
    const lastModified = res.headers.get("last-modified");
    return JSON.stringify({ url, content: text, last_modified: lastModified }, null, 2);
  } catch (e: any) {
    return `Could not fetch URL: ${e.message}`;
  }
}

// ── Search For Updates ─────────────────────────────────────────────────────────

async function runSearchForUpdates(input: Record<string, any>): Promise<string> {
  const { original_claim, original_date } = input;

  const currentYear = new Date().getFullYear();
  const query = `${original_claim} ${currentYear} OR ${currentYear - 1} update correction latest`;

  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        max_results: 5,
        search_depth: "basic",
        include_answer: false,
        include_raw_content: false,
        sort_by: "relevance",
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) return `searchForUpdates error: ${res.status}`;

    const data = await res.json() as {
      results?: { url: string; title: string; content: string; published_date?: string; score?: number }[];
    };

    if (!data.results?.length) return "No recent updates found for this claim.";

    // Filter for results newer than original_date if provided
    const results = data.results.map(r => ({
      url: r.url,
      title: r.title,
      content: r.content?.substring(0, 400),
      published_date: r.published_date,
      relevance_score: r.score,
      is_newer_than_claim: original_date
        ? (r.published_date || "") > original_date
        : null,
    }));

    return JSON.stringify(results, null, 2);
  } catch (e: any) {
    return `searchForUpdates error: ${e.message}`;
  }
}

// ── Caller Memory ──────────────────────────────────────────────────────────────

async function runRetrieveCallerMemory(input: Record<string, any>): Promise<string> {
  const { caller_id } = input;

  const { data, error } = await db
    .from("caller_memory")
    .select("*")
    .eq("caller_id", caller_id)
    .single();

  if (error && error.code === "PGRST116") {
    return JSON.stringify({ caller_id, status: "new_caller", context: {} });
  }
  if (error) return `retrieveCallerMemory error: ${error.message}`;

  return JSON.stringify(data, null, 2);
}

async function runStoreCallerMemory(input: Record<string, any>): Promise<string> {
  const { caller_id, updates } = input;

  const { error } = await db.from("caller_memory").upsert(
    { caller_id, ...updates, updated_at: new Date().toISOString() },
    { onConflict: "caller_id" }
  );

  if (error) return `storeCallerMemory error: ${error.message}`;
  return `Memory saved for caller ${caller_id}`;
}
