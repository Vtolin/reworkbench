import { describe, expect, it } from "vitest";
import { contentSignature, contentTokens, mmrSelect, sectionSimilarity } from "./similarity";

describe("content-word extraction", () => {
  it("keeps short tokens but strips function words", () => {
    expect(contentTokens("Hi AI go x")).toEqual(["hi", "ai", "go"]);
    expect(contentSignature("the cat sat on the mat")).toBe("cat sat mat");
  });
});

describe("sectionSimilarity", () => {
  const physics =
    "Quantum entanglement experiments demonstrate non-local correlations between " +
    "photon pairs measured across distant interferometers with high statistical significance.";

  it("scores identical academic prose at the maximum", () => {
    expect(sectionSimilarity(physics, physics)).toBe(1);
  });

  it("scores topically disjoint prose well below the duplication band", () => {
    const cooking =
      "Banana bread recipes combine ripe bananas with walnuts and cinnamon, baked slowly " +
      "until the crust turns golden brown and fragrant in the oven.";
    expect(sectionSimilarity(physics, cooking)).toBeLessThan(0.5);
  });
});

describe("mmrSelect", () => {
  it("picks the most relevant first, prefers diversity, and stays deterministic", () => {
    const items = [
      { key: "a", relevance: 3, text: "quantum computing hardware advances" },
      { key: "b", relevance: 2, text: "banana bread baking recipes" },
      { key: "c", relevance: 1, text: "quantum computing hardware progress" },
    ];
    const picked = mmrSelect(items, 2);
    expect(picked.map((p) => p.key)).toEqual(["a", "b"]);
    expect(mmrSelect(items, 2).map((p) => p.key)).toEqual(["a", "b"]);
    expect(mmrSelect(items, 0)).toEqual([]);
  });
});
