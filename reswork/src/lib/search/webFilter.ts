/**
 * Pure Anti-AI-Slop filtering and academic/institutional source ranking
 * for BYOK web search results.
 */

export type WebSearchProviderId = "ollama_web" | "google_web" | "tavily" | "brave";

export const WEB_SEARCH_PROVIDERS: readonly WebSearchProviderId[] = [
  "ollama_web",
  "google_web",
  "tavily",
  "brave",
] as const;

export const WEB_SEARCH_PROVIDER_LABELS: Record<WebSearchProviderId, string> = {
  ollama_web: "Ollama Web Search",
  google_web: "Google Search",
  tavily: "Tavily AI Search",
  brave: "Brave Search",
};

export type WebFilterMode = "balanced" | "strict_academic";

export interface RawWebResult {
  title: string;
  url: string;
  content: string;
}

export interface FilteredWebResult {
  title: string;
  url: string;
  domain: string;
  content: string;
  trustTier: "academic" | "government" | "reference" | "general";
  trustScore: number;
}

const SLOP_DOMAINS = new Set([
  "quora.com",
  "pinterest.com",
  "pinterest.co.uk",
  "scribd.com",
  "coursehero.com",
  "studocu.com",
  "chegg.com",
  "brainly.co.id",
  "brainly.com",
  "brainly.in",
  "answers.com",
  "ehow.com",
  "wikihow.com",
  "buzzfeed.com",
  "vocal.media",
  "hubpages.com",
  "ezinearticles.com",
  "gitmemory.com",
  "bountysource.com",
  "programmersought.com",
  "codertw.com",
  "itread01.com",
  "tutorialspoint.com",
  "geeksforgeeks.org",
  "w3schools.com",
  "javatpoint.com",
]);

const ACADEMIC_EXACT = new Set([
  "doi.org",
  "dx.doi.org",
  "arxiv.org",
  "scholar.google.com",
  "ncbi.nlm.nih.gov",
  "pubmed.ncbi.nlm.nih.gov",
  "pmc.ncbi.nlm.nih.gov",
  "semanticscholar.org",
  "ssrn.com",
  "papers.ssrn.com",
  "ieeexplore.ieee.org",
  "dl.acm.org",
  "link.springer.com",
  "nature.com",
  "sciencedirect.com",
  "jstor.org",
  "garuda.kemdikbud.go.id",
  "sinta.kemdikbud.go.id",
  "neliti.com",
  "researchgate.net",
  "openlibrary.org",
  "plos.org",
  "journals.plos.org",
  "tandfonline.com",
  "onlinelibrary.wiley.com",
]);

const GOVERNMENT_EXACT = new Set([
  "peraturan.bpk.go.id",
  "jdih.kemenkeu.go.id",
  "mahkamahkonstitusi.go.id",
  "mkri.id",
  "putusan3.mahkamahagung.go.id",
  "bps.go.id",
  "bi.go.id",
  "ojk.go.id",
  "kpk.go.id",
  "who.int",
  "worldbank.org",
  "data.worldbank.org",
  "oecd.org",
  "un.org",
  "europa.eu",
  "eur-lex.europa.eu",
  "imf.org",
]);

const REFERENCE_EXACT = new Set([
  "wikipedia.org",
  "en.wikipedia.org",
  "id.wikipedia.org",
  "britannica.com",
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "kompas.id",
  "tempo.co",
  "hukumonline.com",
]);

const SLOP_PHRASES: readonly RegExp[] = [
  /\bas an ai language model\b/i,
  /\bin this comprehensive guide,?\s+we will delve\b/i,
  /\bdelve into the intricacies\b/i,
  /\bit is important to note that in today'?s fast-paced\b/i,
  /\bunlock the secrets of\b/i,
  /\benable javascript and cookies to continue\b/i,
  /\bplease verify you are human\b/i,
  /\baccess denied\b.*\bcloudflare\b/i,
];

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "ref",
  "mc_cid",
  "mc_eid",
]);

export function extractHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function normalizeWebUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = "";
    const out = parsed.toString();
    return out.endsWith("/") && parsed.pathname !== "/" ? out.slice(0, -1) : out;
  } catch {
    return null;
  }
}

function matchesDomainOrSubdomain(hostname: string, domains: Set<string>): boolean {
  if (domains.has(hostname)) return true;
  for (const d of domains) {
    if (hostname.endsWith(`.${d}`)) return true;
  }
  return false;
}

export function isSlopDomain(hostname: string, url: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  if (matchesDomainOrSubdomain(host, SLOP_DOMAINS)) return true;
  if (host === "medium.com" || host.endsWith(".medium.com")) {
    try {
      const path = new URL(url).pathname.toLowerCase();
      if (path.startsWith("/tag/") || path.startsWith("/search")) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function isSlopText(title: string, content: string): boolean {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (cleaned.length < 40) return true;
  const combined = `${title} ${cleaned}`;
  for (const re of SLOP_PHRASES) {
    if (re.test(combined)) return true;
  }
  if (/everything you need to know about/i.test(title) && cleaned.length < 140) {
    return true;
  }
  return false;
}

export function scoreDomainTrust(hostname: string): {
  tier: FilteredWebResult["trustTier"];
  score: number;
} {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  if (
    matchesDomainOrSubdomain(host, ACADEMIC_EXACT) ||
    host.endsWith(".edu") ||
    /\.edu\.[a-z]{2,3}$/.test(host) ||
    /\.ac\.[a-z]{2,3}$/.test(host)
  ) {
    return { tier: "academic", score: 30 };
  }
  if (
    matchesDomainOrSubdomain(host, GOVERNMENT_EXACT) ||
    host.endsWith(".gov") ||
    /\.gov\.[a-z]{2,3}$/.test(host) ||
    host.endsWith(".go.id") ||
    host.endsWith(".mil") ||
    host.endsWith(".int")
  ) {
    return { tier: "government", score: 20 };
  }
  if (matchesDomainOrSubdomain(host, REFERENCE_EXACT)) {
    return { tier: "reference", score: 10 };
  }
  return { tier: "general", score: 0 };
}

export function filterAndRankWebResults(
  raw: RawWebResult[],
  opts: { mode?: WebFilterMode; maxResults?: number } = {},
): { results: FilteredWebResult[]; filteredOutCount: number } {
  const mode: WebFilterMode = opts.mode ?? "balanced";
  const maxResults = Math.min(12, Math.max(1, opts.maxResults ?? 6));

  const seenUrls = new Set<string>();
  const seenPrefixes = new Set<string>();
  const kept: Array<{ item: FilteredWebResult; idx: number }> = [];
  let filteredOutCount = 0;

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const title = (entry.title ?? "").replace(/\s+/g, " ").trim();
    const content = (entry.content ?? "").replace(/\s+/g, " ").trim();
    const normalizedUrl = normalizeWebUrl(entry.url ?? "");
    const domain = normalizedUrl ? extractHostname(normalizedUrl) : null;

    if (!normalizedUrl || !domain || !title) {
      filteredOutCount++;
      continue;
    }
    if (isSlopDomain(domain, normalizedUrl) || isSlopText(title, content)) {
      filteredOutCount++;
      continue;
    }

    const prefix = content.slice(0, 120).toLowerCase();
    if (seenUrls.has(normalizedUrl) || seenPrefixes.has(prefix)) {
      filteredOutCount++;
      continue;
    }

    const { tier, score } = scoreDomainTrust(domain);
    if (mode === "strict_academic" && tier === "general") {
      filteredOutCount++;
      continue;
    }

    seenUrls.add(normalizedUrl);
    seenPrefixes.add(prefix);
    kept.push({
      idx: i,
      item: {
        title,
        url: normalizedUrl,
        domain,
        content,
        trustTier: tier,
        trustScore: score,
      },
    });
  }

  kept.sort((a, b) => b.item.trustScore - a.item.trustScore || a.idx - b.idx);
  return {
    results: kept.slice(0, maxResults).map((k) => k.item),
    filteredOutCount,
  };
}
