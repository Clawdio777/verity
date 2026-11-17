/**
 * escalation.ts — what VERITY does when a verdict is right but the evidence behind it is too thin.
 *
 * 17/11/2026: the evidence gate turned correct OUTDATED verdicts ("Taipei 101 is the tallest building
 * in the world", "Angela Merkel is the Chancellor of Germany") into UNVERIFIABLE after one Wikipedia
 * quote, without ever looking for the second source. A missed fact is a failure too.
 *
 * Now, when the gate would downgrade CURRENT / OUTDATED / DISPUTED for thin evidence (never for
 * conflicting evidence), the agent gets up to ESCALATION.rounds more rounds of targeted searching:
 * the authoritative body for the claim's domain first, then independent major outlets. The bar does
 * not move: every new quote is re-fetched and the same gate runs again.
 */

import type { Assessment, CheckedEvidence, SearchLog, Stance, Verdict } from "./evidence.js";

/** Hard caps per claim. Worst case extra spend: see README "Evidence escalation". */
export const ESCALATION = {
  rounds: 2,
  /** Model turns per round, the last of which is forced to answer without tools. */
  turnsPerRound: 3,
  /** Tavily credits all escalation rounds together may spend on searches and fetches. */
  tavilyCredits: 8,
};

const COUNTS_FOR: Record<Verdict, Stance[]> = {
  CURRENT: ["SUPPORTS"],
  OUTDATED: ["SUPERSEDES", "REFUTES"],
  DISPUTED: ["REFUTES", "SUPERSEDES"],
  UNVERIFIABLE: [],
};

/** True when the gate downgraded the verdict only because there was not enough verified evidence. */
export function shouldEscalate(a: Assessment, evidenceToolsWorked: boolean, roundsDone: number): boolean {
  return evidenceToolsWorked && a.gate.verdict === "UNVERIFIABLE" && a.gate.thin === true && roundsDone < ESCALATION.rounds;
}

const line = (c: CheckedEvidence) => `- ${c.organisation}${c.primary ? " (primary)" : ""}, ${c.stance}: "${c.quote.slice(0, 160)}"`;

/** The message that sends the model back out to search, telling it exactly what did and did not count. */
export function escalationPrompt(a: Assessment, round: number): string {
  const wanted = COUNTS_FOR[a.proposed];
  const verified = a.checked.filter((c) => c.verified);
  const counted = verified.filter((c) => wanted.includes(c.stance));
  const notCounted = verified.filter((c) => !wanted.includes(c.stance));
  const failed = a.checked.filter((c) => !c.verified);
  const bar = a.proposed === "DISPUTED"
    ? "DISPUTED needs at least one verified quote that contradicts the claim."
    : `${a.proposed} needs one primary/official source, or two independent organisations, whose verified quotes have stance ${wanted.join(" or ")}.`;
  return [
    `VERITY code check, evidence round ${round} of ${ESCALATION.rounds}: your ${a.proposed} verdict cannot stand yet: ${a.gate.reason}.`,
    bar,
    counted.length ? `Counted so far:\n${counted.map(line).join("\n")}` : "Counted so far: nothing.",
    ...(notCounted.length ? [`Verified but not counted (wrong stance for ${a.proposed}; HISTORICAL only shows it was once true):\n${notCounted.map(line).join("\n")}`] : []),
    ...(failed.length ? [`Not verified (the quote was not found on the re-fetched page):\n${failed.map((c) => `- ${c.url}: ${c.reason}`).join("\n")}`] : []),
    "",
    "Before giving up, search for more evidence from organisations not already counted:",
    "(a) The authoritative body for this claim's domain, quoted from its own site: the government, parliament or official office for an office-holder; the Council on Tall Buildings and Urban Habitat (ctbuh.org, skyscrapercenter.com) for building heights; the standards body for a standard; the company's own site for its products or people; the journal or the paper itself for a study; the official statistics office for a figure. Use searchClaim with include_domains set to that site, then fetchUrl with find= to get the exact sentence.",
    "(b) Independent major outlets: news agencies, national broadcasters and newspapers, or reference works.",
    "",
    "The rules do not change:",
    "- Quote exact sentences from text a tool returned; code re-fetches every page.",
    "- Evidence you already gave stays, with the stance you first gave it. Quoting the same sentence again with a different stance does not count.",
    "- Label every stance honestly. If what you find contradicts your verdict, include it: the answer then becomes DISPUTED, which is better than a wrong verdict.",
    "- If you still cannot settle it, answer UNVERIFIABLE. Do not switch between CURRENT and OUTDATED to get past the check.",
    "Then return the complete JSON answer again.",
  ].join("\n");
}

/** Records the queries and domains every search/fetch tool call tried. */
export class SearchRecorder {
  private queries = new Set<string>();
  private domains = new Set<string>();

  record(tool: string, input: Record<string, any>) {
    const q = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim().slice(0, 200) : null);
    const host = (u: unknown) => { try { return new URL(String(u)).hostname.replace(/^www\./, ""); } catch { return null; } };
    let query: string | null = null;
    if (tool === "searchClaim") {
      const sites = Array.isArray(input?.include_domains) ? input.include_domains.filter((d: unknown) => typeof d === "string") : [];
      sites.forEach((d: string) => this.domains.add(d));
      query = q(input?.query) && (sites.length ? `${q(input.query)} [site: ${sites.join(", ")}]` : q(input.query));
    } else if (tool === "searchForUpdates") query = q(input?.original_claim) && `${q(input.original_claim)} [updates]`;
    else if (tool === "askPerplexity") query = q(input?.query) && `${q(input.query)} [Perplexity]`;
    else if (tool === "checkAcademic") query = q(input?.query) && `${q(input.query)} [Semantic Scholar]`;
    else if (tool === "lookupWikipedia") { query = q(input?.topic) && `${q(input.topic)} [Wikipedia]`; this.domains.add("en.wikipedia.org"); }
    else if (tool === "fetchUrl") { const h = host(input?.url); if (h) this.domains.add(h); }
    if (query) this.queries.add(query);
  }

  /** Adds the domains of quoted sources, which were fetched again to check the quotes. */
  addSources(urls: string[]) {
    for (const u of urls) { try { this.domains.add(new URL(u).hostname.replace(/^www\./, "")); } catch { /* not a URL */ } }
  }

  log(rounds: number): SearchLog {
    return { queries: [...this.queries].slice(0, 30), domains: [...this.domains].slice(0, 30), escalation_rounds: rounds };
  }
}
