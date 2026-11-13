import { describe, expect, it } from "vitest";
import {
  filterAndRankWebResults,
  isSlopDomain,
  isSlopText,
  normalizeWebUrl,
  scoreDomainTrust,
} from "./webFilter";

describe("webFilter", () => {
  it("normalizes URLs by removing tracking params and trailing slash", () => {
    expect(
      normalizeWebUrl("https://www.arxiv.org/abs/2401.00001/?utm_source=x&ref=abc#top"),
    ).toBe("https://www.arxiv.org/abs/2401.00001");
    expect(normalizeWebUrl("javascript:alert(1)")).toBeNull();
  });

  it("blocks content farms, homework mills, and medium tag slop", () => {
    expect(isSlopDomain("www.quora.com", "https://www.quora.com/What-is-law")).toBe(true);
    expect(isSlopDomain("brainly.co.id", "https://brainly.co.id/tugas/123")).toBe(true);
    expect(isSlopDomain("medium.com", "https://medium.com/tag/ai-slop")).toBe(true);
    expect(isSlopDomain("arxiv.org", "https://arxiv.org/abs/2401.00001")).toBe(false);
  });

  it("rejects AI-slop boilerplate and short low-signal snippets", () => {
    expect(isSlopText("Short", "Too short.")).toBe(true);
    expect(
      isSlopText(
        "Guide",
        "As an AI language model, I cannot browse the live web, however in this article...",
      ),
    ).toBe(true);
    expect(
      isSlopText(
        "Constitutional Court Ruling",
        "Putusan Mahkamah Konstitusi Nomor 60/PUU-XXII/2024 mengatur ambang batas pencalonan kepala daerah.",
      ),
    ).toBe(false);
  });

  it("scores Indonesian and international academic/legal domains above general web", () => {
    expect(scoreDomainTrust("repository.ugm.ac.id")).toEqual({ tier: "academic", score: 30 });
    expect(scoreDomainTrust("arxiv.org")).toEqual({ tier: "academic", score: 30 });
    expect(scoreDomainTrust("peraturan.bpk.go.id")).toEqual({ tier: "government", score: 20 });
    expect(scoreDomainTrust("en.wikipedia.org")).toEqual({ tier: "reference", score: 10 });
    expect(scoreDomainTrust("example.com")).toEqual({ tier: "general", score: 0 });
  });

  it("filters slop, deduplicates, ranks by trust tier, and enforces strict_academic mode", () => {
    const sample = [
      {
        title: "Random Blog",
        url: "https://example.org/post",
        content: "General commentary explaining recent economic inflation patterns in Southeast Asia.",
      },
      {
        title: "Quora Spam",
        url: "https://www.quora.com/What-is-inflation",
        content: "Quora answer with generic low quality summary text from unknown author.",
      },
      {
        title: "Peraturan BPK",
        url: "https://peraturan.bpk.go.id/Details/12345?utm_source=google",
        content: "Undang-Undang Nomor 4 Tahun 2009 tentang Pertambangan Mineral dan Batubara.",
      },
      {
        title: "UGM Thesis Mirror Duplicate",
        url: "https://repository.ugm.ac.id/999/?utm_medium=cpc",
        content: "Analisis yuridis pengawasan pertambangan mineral dan batubara pasca UU Cipta Kerja.",
      },
      {
        title: "UGM Thesis Duplicate",
        url: "https://repository.ugm.ac.id/999/",
        content: "Analisis yuridis pengawasan pertambangan mineral dan batubara pasca UU Cipta Kerja.",
      },
    ];

    const balanced = filterAndRankWebResults(sample, { mode: "balanced" });
    expect(balanced.filteredOutCount).toBe(2);
    expect(balanced.results.map((r) => r.domain)).toEqual([
      "repository.ugm.ac.id",
      "peraturan.bpk.go.id",
      "example.org",
    ]);

    const strict = filterAndRankWebResults(sample, { mode: "strict_academic" });
    expect(strict.filteredOutCount).toBe(3);
    expect(strict.results.map((r) => r.domain)).toEqual([
      "repository.ugm.ac.id",
      "peraturan.bpk.go.id",
    ]);
  });
});
