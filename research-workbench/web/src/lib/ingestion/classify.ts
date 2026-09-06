// Port of core/ingestion/classifier.py — deterministic, no LLM.

export type DocumentType = "legal" | "empirical" | "survey" | "thesis" | "general";

const DOC_TYPE_KEYWORDS: Record<Exclude<DocumentType, "general">, string[]> = {
  legal: [
    "putusan", "pengadilan", "mahkamah", "undang-undang", "uu ",
    "perppu", "pasal", "ayat", "jurisdiction", "court", "statute",
    "regulation", "legal",
  ],
  empirical: [
    "methodology", "experiment", "dataset", "evaluation", "baseline",
    "accuracy", "precision", "recall", "participants", "survey", "interview",
  ],
  survey: [
    "literature review", "systematic review", "survey", "taxonomy",
    "state of the art", "comparative analysis",
  ],
  thesis: ["thesis", "dissertation", "skripsi", "tesis", "disertasi"],
};

export function classifyDocumentType(
  textSnippet: string,
  filename: string,
): { docType: DocumentType; confidence: number } {
  const hay = `${filename} ${textSnippet}`.toLowerCase();
  const scores: Partial<Record<DocumentType, number>> = {};
  (Object.keys(DOC_TYPE_KEYWORDS) as Array<Exclude<DocumentType, "general">>).forEach(
    (dtype) => {
      const keywords = DOC_TYPE_KEYWORDS[dtype];
      const hits = keywords.filter((kw) => hay.includes(kw.toLowerCase())).length;
      if (hits > 0) scores[dtype] = hits / keywords.length;
    },
  );
  const entries = Object.entries(scores) as Array<[DocumentType, number]>;
  if (entries.length === 0) return { docType: "general", confidence: 0.45 };
  entries.sort((a, b) => b[1] - a[1]);
  const [best, score] = entries[0];
  return { docType: best, confidence: Math.round(Math.min(0.6 + score, 0.92) * 100) / 100 };
}

export interface CollectionRef {
  id: string;
  name: string;
}

export function suggestCollection(
  documentType: string,
  jurisdiction: string | null,
  year: number | null,
  existingCollections: CollectionRef[],
): { collection: CollectionRef | null; confidence: number; reason: string } {
  if (existingCollections.length === 0) {
    return { collection: null, confidence: 0.4, reason: "No existing collections — suggest creating one" };
  }
  const hayType = (documentType ?? "").toLowerCase();
  const hayJur = (jurisdiction ?? "").toLowerCase();
  let best: CollectionRef | null = null;
  let bestScore = 0;
  let bestReason = "";
  for (const col of existingCollections) {
    const name = col.name.toLowerCase();
    let score = 0;
    const reasons: string[] = [];
    if (hayType && name.includes(hayType)) {
      score += 0.7;
      reasons.push(`type '${documentType}' matches collection`);
    }
    if (hayJur && name.includes(hayJur.split(" ")[0])) {
      score += 0.5;
      reasons.push(`jurisdiction '${jurisdiction}' matches`);
    }
    if (year && name.includes(String(year))) {
      score += 0.3;
      reasons.push(`year ${year} matches`);
    }
    if (score > bestScore) {
      bestScore = score;
      best = col;
      bestReason = reasons.join("; ");
    }
  }
  if (best && bestScore >= 0.5) {
    return {
      collection: best,
      confidence: Math.round(Math.min(0.6 + bestScore * 0.3, 0.92) * 100) / 100,
      reason: bestReason,
    };
  }
  if (best && bestScore > 0) {
    return {
      collection: best,
      confidence: Math.round((0.5 + bestScore * 0.2) * 100) / 100,
      reason: bestReason,
    };
  }
  return { collection: null, confidence: 0.35, reason: "No strong match — consider creating a new collection" };
}
