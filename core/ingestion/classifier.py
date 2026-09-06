"""
Lightweight document classification reusing existing pattern-based extractors.
No LLM - deterministic only for Milestone 1/2 cheap path.
"""
import re
from pathlib import Path

# reuse existing extractors where possible
try:
    from jurisdiction_extraction import extract_jurisdiction
    from metadata_extraction import extract_year
except Exception:
    extract_jurisdiction = lambda *a, **kw: None
    extract_year = lambda *a, **kw: None

DOC_TYPE_KEYWORDS = {
    "legal": ["putusan", "pengadilan", "mahkamah", "undang-undang", "uu ", "perppu", "pasal", "ayat", "jurisdiction", "court", "statute", "regulation", "legal"],
    "empirical": ["methodology", "experiment", "dataset", "evaluation", "baseline", "accuracy", "precision", "recall", "participants", "survey", "interview"],
    "survey": ["literature review", "systematic review", "survey", "taxonomy", "state of the art", "comparative analysis"],
    "thesis": ["thesis", "dissertation", "skripsi", "tesis", "disertasi"],
}

def classify_document_type(text_snippet: str, filename: str) -> tuple[str, float]:
    """
    Returns (doc_type, confidence) from cheapest signals.
    """
    hay = f"{filename} {text_snippet}".lower()
    scores = {}
    for dtype, keywords in DOC_TYPE_KEYWORDS.items():
        hits = sum(1 for kw in keywords if kw.lower() in hay)
        if hits:
            scores[dtype] = hits / len(keywords)
    if not scores:
        return "general", 0.45
    best = max(scores, key=lambda k: scores[k])
    # normalize confidence: hits/len * boost if multiple hits
    conf = min(0.6 + scores[best], 0.92)
    return best, round(conf, 2)

def suggest_collection(document_type: str, jurisdiction: str | None, year: int | None, existing_collections: list[dict]) -> tuple[dict | None, float, str]:
    """
    Suggest existing collection or propose new one.
    Returns (collection_or_None, confidence, reason)
    """
    if not existing_collections:
        return None, 0.4, "No existing collections — suggest creating one"

    # simple heuristic: match collection name to doc_type/jurisdiction
    hay_type = (document_type or "").lower()
    hay_jur = (jurisdiction or "").lower()

    best = None
    best_score = 0
    best_reason = ""
    for col in existing_collections:
        name = col["name"].lower()
        score = 0
        reason = []
        if hay_type and hay_type in name:
            score += 0.7
            reason.append(f"type '{document_type}' matches collection")
        if hay_jur and hay_jur.split()[0] in name:
            score += 0.5
            reason.append(f"jurisdiction '{jurisdiction}' matches")
        # year-based collections like "2024 Papers"
        if year and str(year) in name:
            score += 0.3
            reason.append(f"year {year} matches")
        if score > best_score:
            best_score = score
            best = col
            best_reason = "; ".join(reason)

    if best and best_score >= 0.5:
        conf = min(0.6 + best_score * 0.3, 0.92)
        return best, round(conf, 2), best_reason
    if best and best_score > 0:
        return best, round(0.5 + best_score * 0.2, 2), best_reason
    return None, 0.35, "No strong match — consider creating a new collection"
