/**
 * The code-side verdict check (src/evidence.ts). No network: pages come from an in-memory fetcher.
 * Run: bun test
 */
import { describe, expect, test } from "bun:test";
import {
  checkEvidence, confidenceFor, finaliseResult, gateVerdict, htmlToText, independentOrganisations,
  isPrimarySource, organisationOf, parseModelJson, quoteOnPage, type CheckedEvidence, type PageFetcher,
} from "../src/evidence.ts";

const pagesFetcher = (pages: Record<string, string | null>): PageFetcher => async (urls) =>
  new Map(urls.map((u) => [u, pages[u] ?? null]));

const ev = (over: Partial<CheckedEvidence>): CheckedEvidence => ({
  url: "https://example.com/a", quote: "a quote that is long enough to count", stance: "SUPPORTS",
  verified: true, organisation: "example.com", primary: false, ...over,
});

describe("fix a: quotes must really be on the source page", () => {
  test("whitespace, case, typographic quotes and dashes are normalised", () => {
    const page = "<p>Google  says: “There are <b>no additional</b>\n technical requirements” — really.</p>";
    expect(quoteOnPage('there are no additional technical requirements" - really', htmlToText(page))).toBe(true);
  });
  test("a sentence that is not on the page fails", () => {
    expect(quoteOnPage("There are three additional technical requirements", "There are no additional technical requirements.")).toBe(false);
  });
  test("very short quotes do not count", () => {
    expect(quoteOnPage("in 1990", "It was launched in 1990.")).toBe(false);
  });
  test("elided quotes must match every fragment, in order", () => {
    const page = "Mars has two moons, Phobos and Deimos. Both are thought to be captured asteroids.";
    expect(quoteOnPage("Mars has two moons ... captured asteroids", page)).toBe(true);
    expect(quoteOnPage("captured asteroids ... Mars has two moons", page)).toBe(false);
  });
  test("Wikipedia footnote markers do not break a sentence", () => {
    const html = 'It is exact<sup id="cite_ref-2" class="reference"><a href="#cite_note-2">[2]</a></sup> by international agreement.';
    expect(quoteOnPage("It is exact by international agreement.", htmlToText(html))).toBe(true);
    expect(quoteOnPage("It is exact by international agreement.", "It is exact[2] by international agreement.")).toBe(true);
  });
  test("checkEvidence drops quotes that are not on the page or whose page cannot be fetched", async () => {
    const checked = await checkEvidence([
      { url: "https://a.gov/x", quote: "The rule was retired on 1 July 2025 after review.", stance: "SUPERSEDES" },
      { url: "https://a.gov/x", quote: "An invented sentence that the page never said.", stance: "SUPERSEDES" },
      { url: "https://down.example/y", quote: "Whatever this page might have said about it.", stance: "SUPPORTS" },
    ], "claim", pagesFetcher({ "https://a.gov/x": "Notice. The rule was retired on 1 July 2025 after review." }));
    expect(checked.map((c) => c.verified)).toEqual([true, false, false]);
    expect(checked[2].reason).toContain("could not be fetched");
  });
});

describe("fix b: independence and primary sources", () => {
  test("subdomains and sibling domains of one organisation count once", () => {
    expect(organisationOf("https://developers.google.com/x")).toBe("google.com");
    expect(organisationOf("https://blog.google/y")).toBe("google.com");
    expect(organisationOf("https://www.bbc.co.uk/news")).toBe("bbc.co.uk");
    expect(organisationOf("https://www.health.gov.au/a")).toBe("health.gov.au");
  });
  test("government, standards and science bodies are primary for anything", () => {
    expect(isPrimarySource("https://science.nasa.gov/mars/moons/", "Mars has two moons")).toBe(true);
    expect(isPrimarySource("https://www.rfc-editor.org/rfc/rfc9110.html", "HTTP 404")).toBe(true);
    expect(isPrimarySource("https://arxiv.org/abs/2311.09735", "GEO paper")).toBe(true);
  });
  test("a company's own site is primary only for claims about that company", () => {
    expect(isPrimarySource("https://developers.google.com/search/docs", "Google says AI Overviews need nothing extra")).toBe(true);
    expect(isPrimarySource("https://platform.openai.com/docs/bots", "Sites that block OAI-SearchBot are not shown in ChatGPT")).toBe(true);
    expect(isPrimarySource("https://developers.google.com/search/docs", "Pluto is a planet")).toBe(false);
    expect(isPrimarySource("https://ahrefs.com/blog/x", "An Ahrefs study found 34.5% fewer clicks")).toBe(true);
    expect(isPrimarySource("https://someseoblog.com/x", "Google says AI Overviews need nothing extra")).toBe(false);
  });
  test("the same sentence syndicated on two sites counts as one source", () => {
    const q = "The company announced the product would be discontinued in March.";
    expect(independentOrganisations([ev({ organisation: "a.com", quote: q }), ev({ organisation: "b.com", quote: q })])).toBe(1);
    expect(independentOrganisations([ev({ organisation: "a.com" }), ev({ organisation: "b.com", quote: "a different sentence from another outlet" })])).toBe(2);
  });
  test("CURRENT on one non-primary source is not enough", () => {
    expect(gateVerdict("CURRENT", [ev({})]).verdict).toBe("UNVERIFIABLE");
  });
  test("CURRENT on two independent organisations stands", () => {
    expect(gateVerdict("CURRENT", [ev({}), ev({ url: "https://b.org/x", organisation: "b.org", quote: "another outlet says the same thing here" })]).verdict).toBe("CURRENT");
  });
  test("CURRENT on one primary source stands", () => {
    expect(gateVerdict("CURRENT", [ev({ primary: true })]).verdict).toBe("CURRENT");
  });
  test("OUTDATED needs evidence of the change, not just that it was once true", () => {
    expect(gateVerdict("OUTDATED", [ev({ primary: true, stance: "HISTORICAL" })]).verdict).toBe("UNVERIFIABLE");
    expect(gateVerdict("OUTDATED", [ev({ primary: true, stance: "SUPERSEDES" })]).verdict).toBe("OUTDATED");
  });
});

describe("fix c: confidence comes from the evidence, not the model", () => {
  test("tiers", () => {
    const other = ev({ url: "https://b.org/x", organisation: "b.org", quote: "another outlet says the same thing here" });
    expect(confidenceFor("CURRENT", [ev({ primary: true }), other])).toBe(90);
    expect(confidenceFor("CURRENT", [ev({ primary: true })])).toBe(80);
    expect(confidenceFor("CURRENT", [ev({}), other])).toBe(65);
    expect(confidenceFor("UNVERIFIABLE", [ev({ primary: true })])).toBe(0);
  });
  test("a model-supplied confidence is discarded", async () => {
    const r = await finaliseResult({
      modelText: JSON.stringify({ verdict: "CURRENT", confidence: 99, summary: "s", evidence: [{ url: "https://x.gov/a", quote: "The office is open on weekdays from nine.", stance: "SUPPORTS" }] }),
      claim: "c", evidenceToolsWorked: true, fetcher: pagesFetcher({ "https://x.gov/a": "The office is open on weekdays from nine." }),
    });
    expect(r!.verdict).toBe("CURRENT");
    expect(r!.confidence).toBe(80);
    expect(r!.evidence_summary).toMatchObject({ verified_quotes: 1, primary_source: true, independent_organisations: 1 });
  });
});

describe("fix d: unsure or conflicting evidence never becomes a confident verdict", () => {
  test("verified evidence on both sides makes CURRENT into DISPUTED", () => {
    const g = gateVerdict("CURRENT", [ev({ primary: true }), ev({ url: "https://c.gov/z", organisation: "c.gov", primary: true, stance: "REFUTES", quote: "this is not the case any longer at all" })]);
    expect(g.verdict).toBe("DISPUTED");
  });
  test("DISPUTED needs a verified contradicting quote", () => {
    expect(gateVerdict("DISPUTED", [ev({ stance: "SUPPORTS" })]).verdict).toBe("UNVERIFIABLE");
    expect(gateVerdict("DISPUTED", [ev({ stance: "REFUTES" })]).verdict).toBe("DISPUTED");
  });
  test("a quote that is not on the page downgrades the verdict, with the reason", async () => {
    const r = await finaliseResult({
      modelText: '{"verdict":"OUTDATED","what_changed":"renamed","summary":"s","evidence":[{"url":"https://x.gov/a","quote":"The plan was renamed on 1 July 2025 by the department.","stance":"SUPERSEDES"}]}',
      claim: "c", evidenceToolsWorked: true, fetcher: pagesFetcher({ "https://x.gov/a": "Nothing about any renaming here." }),
    });
    expect(r!.verdict).toBe("UNVERIFIABLE");
    expect(r!.downgraded_from).toBe("OUTDATED");
    expect(r!.downgrade_reason).toContain("could be found");
    expect(r!.what_changed).toBeNull();
    expect(r!.sources).toEqual([]);
    expect(r!.unverified_quotes).toHaveLength(1);
  });
});

describe("fix e: no verdict or source is filled in when tools fail", () => {
  test("when every search/fetch tool failed, even a quoted verdict becomes UNVERIFIABLE", async () => {
    const r = await finaliseResult({
      modelText: '{"verdict":"CURRENT","summary":"from memory","evidence":[{"url":"https://x.gov/a","quote":"Canberra is the capital city of Australia.","stance":"SUPPORTS"}]}',
      claim: "c", evidenceToolsWorked: false, fetcher: pagesFetcher({ "https://x.gov/a": "Canberra is the capital city of Australia." }),
    });
    expect(r!.verdict).toBe("UNVERIFIABLE");
    expect(r!.downgrade_reason).toContain("tools failed");
    expect(r!.sources).toEqual([]);
  });
  test("a verdict with no evidence at all is UNVERIFIABLE", async () => {
    const r = await finaliseResult({ modelText: '{"verdict":"CURRENT","summary":"s"}', claim: "c", evidenceToolsWorked: true, fetcher: pagesFetcher({}) });
    expect(r!.verdict).toBe("UNVERIFIABLE");
  });
  test("unparseable output returns null so the run fails and nobody is charged", async () => {
    expect(await finaliseResult({ modelText: 'prose "verdict": "CURRENT" but no json', claim: "c", evidenceToolsWorked: true, fetcher: pagesFetcher({}) })).toBeNull();
  });
  test("the JSON is read from a fenced block after prose", () => {
    expect(parseModelJson('Done.\n```json\n{"verdict":"DISPUTED"}\n```')?.verdict).toBe("DISPUTED");
  });
});

describe("fix b (search side): official sources are read first and can be quoted from deep in a page", () => {
  test("official results move to the top, otherwise order is kept", async () => {
    const { rankOfficialFirst } = await import("../src/evidence.ts");
    const ranked = rankOfficialFirst([
      { url: "https://seoblog.com/a" }, { url: "https://developers.google.com/search/docs/x" }, { url: "https://news.com/b" },
    ], "Google AI Overviews requirements");
    expect(ranked.map((r) => r.url)).toEqual(["https://developers.google.com/search/docs/x", "https://seoblog.com/a", "https://news.com/b"]);
  });
  test("pageExcerpt adds the passage around a phrase that sits past the cut-off", async () => {
    const { pageExcerpt } = await import("../src/evidence.ts");
    const page = "intro ".repeat(1000) + "There are no additional technical requirements for AI Overviews." + " tail".repeat(200);
    expect(pageExcerpt(page)).not.toContain("no additional technical requirements");
    expect(pageExcerpt(page, "additional technical requirements")).toContain("There are no additional technical requirements for AI Overviews.");
  });
});
