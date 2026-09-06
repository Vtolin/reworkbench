"""
LLM-backed research analysis (Phase 5 matrix, Phase 8 legal, Phase 9
extraction/synthesis).

Everything here is a thin prompt + call layer over llm_client.chat
(Ollama). Deterministic facts stay deterministic (see core/legal/
extraction.py and summarization's verbatim layer); these functions handle
the interpretive work a model is actually good at.
"""
import json
import re

from llm_client import chat
from retrieval import get_chunks_by_source, sort_docs
from config import (
    REDUCE_MODEL, REDUCE_NUM_CTX, REDUCE_NUM_PREDICT,
    SYNTHESIS_MODEL, NUM_CTX, SYNTHESIS_NUM_PREDICT,
    GENERATION_TEMPERATURE,
)

_JSON_BLOCK_RE = re.compile(r"\{.*\}", re.DOTALL)


def _extract_json(text: str) -> dict | None:
    """Recover a JSON object from a model response (code-fenced or not)."""
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned).strip()
    try:
        return json.loads(cleaned)
    except Exception:
        m = _JSON_BLOCK_RE.search(cleaned)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
        return None


def _doc_text(vs, doc: dict, max_chars: int = 60000) -> str:
    """Stitched text of one document (its chunks concatenated, capped)."""
    source = doc.get("stored_path")
    if not source:
        return ""
    try:
        chunks = sort_docs(get_chunks_by_source(vs, source))
    except Exception:
        return ""
    text = "\n\n".join(c.page_content for c in chunks)
    return text[:max_chars]


def _chat_json(system: str, user: str, model=REDUCE_MODEL, num_ctx=REDUCE_NUM_CTX,
               num_predict=REDUCE_NUM_PREDICT) -> dict | None:
    try:
        response = chat(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            num_ctx=num_ctx,
            num_predict=num_predict,
            temperature=GENERATION_TEMPERATURE,
        )
    except Exception:
        return None
    return _extract_json(response or "")


MATRIX_SYSTEM = (
    "You are a meticulous research analyst. Extract the requested fields "
    "from the provided document text into STRICT JSON with keys: method, "
    "dataset, findings, limitations, year. Every value is a string; use "
    "'n/a' when the text does not state it. Do not invent anything. "
    "Reply with ONLY the JSON object."
)

MATRIX_COLUMNS = ["method", "dataset", "findings", "limitations", "year"]


def literature_matrix(vs, docs: list[dict]) -> list[dict]:
    """One row per document: {paper, year, method, dataset, findings, limitations}."""
    rows = []
    for doc in docs:
        text = _doc_text(vs, doc, max_chars=30000)
        row = {"paper": doc.get("title") or doc.get("original_filename") or "Untitled",
               "year": doc.get("year"), "method": "", "dataset": "", "findings": "",
               "limitations": ""}
        if text:
            parsed = _chat_json(
                MATRIX_SYSTEM,
                f"Document: {row['paper']}\n\nText:\n{text[:28000]}",
                model=SYNTHESIS_MODEL, num_ctx=NUM_CTX, num_predict=1024,
            )
            if parsed:
                for key in MATRIX_COLUMNS:
                    row[key] = str(parsed.get(key) or "").strip() or row.get(key) or ""
        rows.append(row)
    return rows


PAPER_SCHEMA_FIELDS = [
    "methodology", "research_question", "dataset", "findings",
    "limitations", "contributions", "key_citations", "future_work",
]
LEGAL_SCHEMA_FIELDS = [
    "facts", "issues", "legal_basis", "arguments", "considerations",
    "ratio_decidendi", "obiter_dictum", "holding",
]

_SCHEMAS = {
    "paper": PAPER_SCHEMA_FIELDS,
    "legal": LEGAL_SCHEMA_FIELDS,
}

_EXTRACT_SYSTEM = (
    "You are an expert academic/legal analyst. Extract the requested fields "
    "from the provided document text into STRICT JSON. Values are strings; "
    "use 'n/a' when the text does not state it. Never invent content. For "
    "Indonesian legal documents (putusan), preserve Pasal/ayat and statute "
    "citations exactly. Reply with ONLY the JSON object."
)


def structured_extract(vs, doc: dict, schema: str = "paper") -> dict:
    """One-click structured extraction with a configurable checklist."""
    fields = _SCHEMAS.get(schema, PAPER_SCHEMA_FIELDS)
    text = _doc_text(vs, doc)
    result = {"schema": schema, "title": doc.get("title") or doc.get("original_filename")}
    if not text:
        result.update({f: "n/a" for f in fields})
        return result
    parsed = _chat_json(
        _EXTRACT_SYSTEM
        + f" The JSON keys must be exactly: {', '.join(fields)}.",
        f"Document: {doc.get('title') or ''}\n\nText:\n{text[:50000]}",
        model=SYNTHESIS_MODEL, num_ctx=NUM_CTX, num_predict=2048,
    )
    for field in fields:
        result[field] = str((parsed or {}).get(field) or "n/a")
    return result


SYNTHESIS_SYSTEM = (
    "You are a rigorous research analyst comparing multiple documents. "
    "Answer the question using ONLY the labeled excerpts. Structure the "
    "answer with these sections (markdown): "
    "**Agreement**, **Disagreement**, **Research gaps**, **Claims by support** "
    "(list claims and which sources support them). Attribute every claim to "
    "its source by name. If sources conflict, say so explicitly - never "
    "average them into one position."
)


def cross_paper_synthesis(vs, docs: list[dict], question: str) -> str:
    """Cross-paper synthesis: agreement/disagreement/gaps/claim support."""
    sections = []
    for doc in docs:
        text = _doc_text(vs, doc, max_chars=8000)
        label = doc.get("title") or doc.get("original_filename") or f"doc {doc.get('id')}"
        sections.append(f"=== {label} ===\n{text or '(no text available)'}")
    context = "\n\n".join(sections)
    if not context.strip():
        return "No document text available for synthesis."
    try:
        return chat(
            model=SYNTHESIS_MODEL,
            messages=[
                {"role": "system", "content": SYNTHESIS_SYSTEM},
                {"role": "user", "content": f"Question: {question}\n\nExcerpts:\n{context}"},
            ],
            num_ctx=NUM_CTX,
            num_predict=SYNTHESIS_NUM_PREDICT,
            temperature=GENERATION_TEMPERATURE,
        ) or ""
    except Exception as e:
        return f"Synthesis failed: {e}"


LEGAL_ANALYSIS_SYSTEM = (
    "You are an expert in Indonesian constitutional and civil law analysis. "
    "Analyze the provided court decision (putusan) into STRICT JSON with keys: "
    "facts, issues, legal_basis, arguments, considerations, ratio_decidendi, "
    "obiter_dictum, holding. Values are strings in markdown; preserve Pasal/ayat "
    "and statute citations exactly. Use 'n/a' for missing parts. Reply with "
    "ONLY the JSON object."
)


def legal_analysis(vs, doc: dict) -> dict:
    """Structured legal reasoning extraction for a case document."""
    text = _doc_text(vs, doc)
    result = {"title": doc.get("title") or doc.get("original_filename")}
    if not text:
        result.update({f: "n/a" for f in LEGAL_SCHEMA_FIELDS})
        return result
    parsed = _chat_json(
        LEGAL_ANALYSIS_SYSTEM,
        f"Decision: {doc.get('title') or ''}\n\nText:\n{text[:50000]}",
        model=SYNTHESIS_MODEL, num_ctx=NUM_CTX, num_predict=2048,
    )
    for field in LEGAL_SCHEMA_FIELDS:
        result[field] = str((parsed or {}).get(field) or "n/a")
    return result
