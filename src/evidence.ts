/**
 * evidence.ts — the code-side check on every VERITY verdict.
 *
 * The model proposes a verdict plus exact quotes from its sources. Code then:
 *   1. re-fetches every quoted page and confirms the quote is really on it (whitespace, case,
 *      quote marks and dashes normalised); a quote that cannot be found is dropped;
 *   2. requires CURRENT / OUTDATED to rest on one primary/official source or on two independent
 *      organisations (syndicated copies of the same sentence count once);
 *   3. turns contradicting verified evidence into DISPUTED and missing evidence into UNVERIFIABLE;
 *   4. derives `confidence` from that evidence (see README "Confidence"), never from the model.
 */

export type Verdict = "CURRENT" | "OUTDATED" | "DISPUTED" | "UNVERIFIABLE";
export type Stance = "SUPPORTS" | "REFUTES" | "SUPERSEDES" | "HISTORICAL";

export interface EvidenceItem {
  url: string;
  quote: string;
  stance: Stance;
  title?: string;
  published_date?: string | null;
}

export interface CheckedEvidence extends EvidenceItem {
  verified: boolean;
  organisation: string;
  primary: boolean;
  reason?: string;
}

export interface EvidenceSummary {
  verified_quotes: number;
  unverified_quotes: number;
  independent_organisations: number;
  primary_source: boolean;
  newest_source_date: string | null;
}

/** Fetches a page and returns its readable text, or null when it cannot be read. */
export type PageFetcher = (urls: string[]) => Promise<Map<string, string | null>>;

// ── Text normalisation ──────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-",
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: "...", middot: "·", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<sup\b[^>]*class="[^"]*reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, "") // Wikipedia footnote markers
      .replace(/<(p|div|li|h[1-6]|tr|br|td|th|section|article)\b/gi, " <$1")
      .replace(/<[^>]+>/g, ""),
  );
}

/** Lower-case, one space between words, typographic quotes/dashes made plain, markdown link syntax removed. */
export function normaliseText(s: string): string {
  return decodeEntities(s)
    .normalize("NFKC")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // markdown links/images -> their text
    .replace(/\[(\d+|[a-z]|citation needed|note \d+)\]/gi, "") // footnote markers such as [12]
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[*_#>|\[\]]/g, " ") // markdown emphasis, headings, tables
    .replace(/[ ​\s]+/g, " ")
    .trim()
    .toLowerCase();
}

const MIN_QUOTE_CHARS = 20;

/** True when the quote (or, if it was elided with "...", every fragment in order) is on the page. */
export function quoteOnPage(quote: string, pageText: string): boolean {
  const page = normaliseText(pageText);
  const fragments = normaliseText(quote.replace(/…/g, "...")).split(/\s*\.\.\.\s*/).map((f) => f.replace(/^["']|["']$/g, "").trim()).filter(Boolean);
  if (!fragments.length || fragments.join(" ").length < MIN_QUOTE_CHARS) return false;
  let from = 0;
  for (const f of fragments) {
    if (f.length < 8) return false;
    const at = page.indexOf(f, from);
    if (at < 0) return false;
    from = at + f.length;
  }
  return true;
}

// ── Organisations and primary sources ───────────────────────────────────────

const TWO_LEVEL_SUFFIXES = new Set([
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "co.nz", "org.nz", "govt.nz", "ac.nz",
  "co.jp", "or.jp", "ac.jp", "go.jp", "com.br", "gov.br", "co.in", "gov.in", "ac.in", "com.cn", "gov.cn",
  "co.za", "gov.za", "com.sg", "gov.sg", "gc.ca", "com.mx", "gob.mx", "europa.eu",
]);

// Domains owned by the same organisation count as one source.
const SAME_ORGANISATION: Record<string, string> = {
  "blog.google": "google.com", "web.dev": "google.com", "withgoogle.com": "google.com", "youtube.com": "google.com",
  "googleblog.com": "google.com", "chatgpt.com": "openai.com", "claude.ai": "anthropic.com", "claude.com": "anthropic.com",
  "twitter.com": "x.com", "facebook.com": "meta.com", "fb.com": "meta.com", "instagram.com": "meta.com",
  "bing.com": "microsoft.com", "live.com": "microsoft.com",
};

export function organisationOf(url: string): string {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return url; }
  const parts = host.split(".");
  const lastTwo = parts.slice(-2).join(".");
  const domain = TWO_LEVEL_SUFFIXES.has(lastTwo) && parts.length >= 3 ? parts.slice(-3).join(".") : lastTwo;
  return SAME_ORGANISATION[domain] ?? SAME_ORGANISATION[host] ?? domain;
}

// Institutions that are primary for anything they publish: governments, intergovernmental and
// standards bodies, universities, scientific publishers and the paper repositories studies live on.
const PRIMARY_SUFFIXES = [".gov", ".mil", ".int", ".edu", ".gov.au", ".edu.au", ".gov.uk", ".ac.uk", ".govt.nz", ".gc.ca", ".europa.eu", ".gov.in", ".go.jp"];
const PRIMARY_INSTITUTIONS = new Set([
  "w3.org", "schema.org", "ietf.org", "rfc-editor.org", "iso.org", "whatwg.org", "unicode.org", "bipm.org", "iupac.org",
  "un.org", "who.int", "oecd.org", "imf.org", "worldbank.org", "iau.org", "nobelprize.org", "ipcc.ch",
  "arxiv.org", "doi.org", "acm.org", "ieee.org", "nature.com", "science.org", "thelancet.com", "nejm.org", "bmj.com", "cochranelibrary.com",
]);
// A company's own site is primary for claims about that company or its products.
const VENDOR_NAMES: Record<string, string[]> = {
  "google.com": ["google", "gemini", "bard", "ai overviews", "ai overview", "ai mode", "search console", "chrome", "android", "googlebot", "youtube", "e-e-a-t", "core web vitals"],
  "openai.com": ["openai", "chatgpt", "gpt", "gptbot", "oai-searchbot", "sora", "dall-e"],
  "anthropic.com": ["anthropic", "claude", "claudebot"],
  "perplexity.ai": ["perplexity", "perplexitybot"],
  "microsoft.com": ["microsoft", "bing", "copilot", "windows", "internet explorer", "edge", "indexnow"],
  "meta.com": ["meta", "facebook", "instagram", "whatsapp", "llama"],
  "x.com": ["twitter", "x.com", "tweet"],
  "apple.com": ["apple", "iphone", "siri", "applebot"],
};

export function isPrimarySource(url: string, claim: string): boolean {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return false; }
  if (PRIMARY_SUFFIXES.some((s) => host.endsWith(s))) return true;
  const org = organisationOf(url);
  if (PRIMARY_INSTITUTIONS.has(org)) return true;
  const c = claim.toLowerCase();
  const names = VENDOR_NAMES[org] ?? [];
  const label = org.split(".")[0];
  if (label.length >= 4 && new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(c)) return true;
  return names.some((n) => new RegExp(`(^|[^a-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(c));
}

// ── Page fetching ───────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (compatible; VERITY-Bot/1.1; +https://verity.basechainlabs.com)";

async function fetchDirect(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,text/plain,application/xhtml+xml" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/text|html|xml|json|markdown/.test(type)) return null;
    const body = (await res.text()).slice(0, 4_000_000);
    return /html|xml/.test(type) ? htmlToText(body) : body;
  } catch {
    return null;
  }
}

/** Tavily Extract for pages that block plain fetches or render with JavaScript. Returns credits used. */
async function fetchViaTavily(urls: string[], out: Map<string, string | null>): Promise<number> {
  const key = process.env.TAVILY_API_KEY;
  if (!key || !urls.length) return 0;
  let credits = 0;
  for (let i = 0; i < urls.length; i += 20) {
    const batch = urls.slice(i, i + 20);
    credits += Math.ceil(batch.length / 5);
    try {
      const res = await fetch("https://api.tavily.com/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ urls: batch }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { results?: { url: string; raw_content?: string }[] };
      for (const r of data.results ?? []) {
        const match = batch.find((u) => u === r.url) ?? batch.find((u) => stripUrl(u) === stripUrl(r.url));
        if (match && r.raw_content) out.set(match, r.raw_content);
      }
    } catch {
      // leave these URLs unread: their quotes stay unverified
    }
  }
  return credits;
}

const stripUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[#?].*$/, "").replace(/\/$/, "");

export interface FetchStats { tavily_credits: number }

/**
 * Default fetcher: plain fetch first, then Tavily Extract for anything that failed.
 * `wanted` (url -> quotes) lets it also try Tavily when a page loaded but the quote is not in
 * the raw HTML (JavaScript-rendered pages).
 */
export function defaultFetcher(stats: FetchStats, wanted?: Map<string, string[]>): PageFetcher {
  return async (urls) => {
    const out = new Map<string, string | null>();
    await Promise.all(urls.map(async (u) => out.set(u, await fetchDirect(u))));
    const retry = urls.filter((u) => {
      const text = out.get(u);
      if (!text) return true;
      const quotes = wanted?.get(u) ?? [];
      return quotes.length > 0 && !quotes.every((q) => quoteOnPage(q, text));
    });
    if (retry.length) {
      const viaTavily = new Map<string, string | null>();
      stats.tavily_credits += await fetchViaTavily(retry, viaTavily);
      for (const [u, t] of viaTavily) {
        const prev = out.get(u);
        out.set(u, prev ? `${prev}\n${t}` : t);
      }
    }
    return out;
  };
}

// ── Quote verification ──────────────────────────────────────────────────────

const STANCES: Stance[] = ["SUPPORTS", "REFUTES", "SUPERSEDES", "HISTORICAL"];

export function readEvidence(raw: unknown): EvidenceItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e: any) => {
    if (!e || typeof e.url !== "string" || typeof e.quote !== "string" || !/^https?:\/\//.test(e.url)) return [];
    const stance = String(e.stance ?? "").toUpperCase() as Stance;
    if (!STANCES.includes(stance)) return [];
    return [{ url: e.url.trim(), quote: e.quote, stance, title: typeof e.title === "string" ? e.title : undefined, published_date: typeof e.published_date === "string" ? e.published_date : null }];
  });
}

export async function checkEvidence(items: EvidenceItem[], claim: string, fetcher: PageFetcher): Promise<CheckedEvidence[]> {
  const urls = [...new Set(items.map((i) => i.url))];
  const pages = urls.length ? await fetcher(urls) : new Map<string, string | null>();
  return items.map((i) => {
    const page = pages.get(i.url);
    const base = { ...i, organisation: organisationOf(i.url), primary: isPrimarySource(i.url, claim) };
    if (!page) return { ...base, verified: false, reason: "source page could not be fetched" };
    if (!quoteOnPage(i.quote, page)) return { ...base, verified: false, reason: "quote not found on the source page" };
    return { ...base, verified: true };
  });
}

// ── The verdict gate ────────────────────────────────────────────────────────

/** Distinct organisations, counting the same sentence published on several sites (syndication) once. */
export function independentOrganisations(items: CheckedEvidence[]): number {
  const orgs = new Set<string>();
  const quotes = new Set<string>();
  let n = 0;
  for (const i of items) {
    const q = normaliseText(i.quote);
    if (!orgs.has(i.organisation) && !quotes.has(q)) n++;
    orgs.add(i.organisation);
    quotes.add(q);
  }
  return n;
}

const meetsBar = (items: CheckedEvidence[]) => items.some((i) => i.primary) || independentOrganisations(items) >= 2;

function newestDate(items: CheckedEvidence[]): string | null {
  const dates = items.map((i) => (i.published_date ? Date.parse(i.published_date) : NaN)).filter((t) => Number.isFinite(t) && t <= Date.now() + 86_400_000);
  return dates.length ? new Date(Math.max(...dates)).toISOString().slice(0, 10) : null;
}

/** Confidence is a fixed label for the evidence tier, not a probability. Documented in the README. */
export function confidenceFor(verdict: Verdict, items: CheckedEvidence[]): number {
  if (verdict === "UNVERIFIABLE" || !items.length) return 0;
  const primary = items.some((i) => i.primary);
  const orgs = independentOrganisations(items);
  if (primary && orgs >= 2) return 90;
  if (primary) return 80;
  if (orgs >= 3) return 75;
  if (orgs >= 2) return 65;
  return 40;
}

export interface GateResult {
  verdict: Verdict;
  confidence: number;
  reason?: string;
  basis: CheckedEvidence[];
  summary: EvidenceSummary;
}

export function gateVerdict(proposed: Verdict, checked: CheckedEvidence[]): GateResult {
  const ok = checked.filter((c) => c.verified);
  const by = (...s: Stance[]) => ok.filter((c) => s.includes(c.stance));
  const summary: EvidenceSummary = {
    verified_quotes: ok.length,
    unverified_quotes: checked.length - ok.length,
    independent_organisations: independentOrganisations(ok),
    primary_source: ok.some((c) => c.primary),
    newest_source_date: newestDate(ok),
  };
  const result = (verdict: Verdict, basis: CheckedEvidence[], reason?: string): GateResult =>
    ({ verdict, confidence: confidenceFor(verdict, basis), reason, basis, summary });

  if (!ok.length) {
    return result("UNVERIFIABLE", [], checked.length ? "none of the quoted source sentences could be found on the source pages" : "no quoted source sentences were returned");
  }

  if (proposed === "CURRENT" || proposed === "OUTDATED") {
    const support = proposed === "CURRENT" ? by("SUPPORTS") : by("SUPERSEDES", "REFUTES");
    const against = proposed === "CURRENT" ? by("REFUTES", "SUPERSEDES") : by("SUPPORTS");
    if (against.length && support.length) return result("DISPUTED", [...support, ...against], "verified sources conflict");
    if (!meetsBar(support)) {
      return result("UNVERIFIABLE", [], `${proposed} needs one primary/official source or two independent organisations with verified quotes; found ${independentOrganisations(support)} non-primary`);
    }
    return result(proposed, support);
  }

  if (proposed === "DISPUTED") {
    const against = by("REFUTES", "SUPERSEDES");
    if (!against.length) return result("UNVERIFIABLE", [], "DISPUTED needs at least one verified contradicting source");
    return result("DISPUTED", [...against, ...by("SUPPORTS")]);
  }

  return result("UNVERIFIABLE", []);
}
