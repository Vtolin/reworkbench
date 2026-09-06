"""
Central configuration for the Thesis RAG Assistant — Ollama-only.

All LLM and embedding calls go through Ollama. The gemma4 26B model runs
locally via `ollama run gemma4:26b-a4b-it-qat` (or any tag you set below).
Context length, temperature and other Ollama options are set per-request
here; the UI's Settings page can override the chat-related values at
runtime via the SQLite `settings` table (see `get_chat_config` in this
module and `storage.sqlite.DEFAULT_SETTINGS`).
"""

# --- Storage / corpus ---
PERSIST_DIR = "./chroma_db"
DOC_FOLDER = "./pfolder"

# Where 'summarize: X html' writes its styled HTML reports.
SUMMARY_EXPORT_DIR = "./summaries"

# --- Chunking (ingestion) ---
CHUNK_SIZE = 4700
CHUNK_OVERLAP = 880

# --- Retrieval: narrow ---
SIMILARITY_K = 10
BM25_K = 10
HYBRID_TOP_N = 8

# --- Retrieval: broad ---
BROAD_K = 15
BROAD_FETCH_K = 30
BROAD_BM25_K = 15
BROAD_TOP_N = 12

BM25_WEIGHT = 0.4
VECTOR_WEIGHT = 0.6

# --- Cross-encoder re-ranking ---
RERANK_MODEL = "ms-marco-MiniLM-L-12-v2"
RERANK_CACHE_DIR = "./rerank_cache"

# --- Model routing (Ollama-only) ---
# Every stage below runs on Ollama. Each *_MODEL is the Ollama tag to
# pull/run (e.g. `ollama pull gemma4:26b-a4b-it-qat`). Different stages
# can use different tags — e.g. a small/fast model for map/reduce and
# the 26B model for RAG + synthesis — but they all talk to the same
# Ollama daemon (default http://localhost:11434).

# Chat / RAG — the model that powers the Research > Ask chat.
RAG_PROVIDER = "ollama"
RAG_MODEL = "gemma4:26b-a4b-it-qat"
# Ollama provider is fixed; thinking mode (think=true) is always
# available on Ollama for reasoning models (Qwen3, DeepSeek, etc.).
# For gemma4 the toggle still controls the <think> prompt instruction
# and Ollama's `think` flag.
THINKING_AVAILABLE = True

# Summarization pipeline
# Map: bulk fact extraction from document batches — small/fast is ideal.
MAP_PROVIDER = "ollama"
MAP_MODEL = "qwen3.5:4b"

# Reduce/consolidation: merging + deduplicating extract batches.
REDUCE_PROVIDER = "ollama"
REDUCE_MODEL = "qwen2.5:7b"

# Synthesis: final narrative summary — the heaviest model (26B).
SYNTHESIS_PROVIDER = "ollama"
SYNTHESIS_MODEL = "gemma4:26b-a4b-it-qat"

# Doc-type classification (tiny 32-token call) — reuse the map model.
DOC_TYPE_PROVIDER = "ollama"
DOC_TYPE_MODEL = "qwen3.5:4b"

# --- Embeddings (Ollama) ---
# Changing the embedding model changes the vector space — run
# 'reindex' or re-ingest after switching.
EMBED_PROVIDER = "ollama"
EMBED_MODEL = "nomic-embed-text"

# --- Ollama generation options ---
# Per-request `num_ctx` controls the KV-cache size for this call.
# For the 26B gemma4 model the physical context window is 128k, but
# the effective value you can use is bounded by VRAM. The Settings
# page lets you tune this at runtime without editing this file.
NUM_CTX = 32768
CTX_SAFETY_MARGIN = 800
GENERATION_TEMPERATURE = 0.0

# num_predict (max tokens to generate) for the chat endpoint.
# 0 or None means "model default / unlimited".
RAG_NUM_PREDICT = 2048

# Stage-specific caps
DOC_TYPE_NUM_CTX = 4096
DOC_TYPE_NUM_PREDICT = 32

MAP_NUM_CTX = 6144
MAP_NUM_PREDICT = 2688
MAP_BUDGET_RATIO = 0.55

REDUCE_NUM_CTX = 12288
REDUCE_NUM_PREDICT = 2048
REDUCE_BUDGET_RATIO = 0.60

SYNTHESIS_NUM_PREDICT = 5120

# Force intermediate reduce when more than this many extracts exist,
# even if they fit in the final context window.
FORCE_REDUCE_EXTRACT_THRESHOLD = 8

# --- Conversation memory ---
MAX_HISTORY_TURNS = 3

# --- Compare mode ---
COMPARE_TOP_N_PER_SOURCE = 5

# --- Whole-document summarization ---
SUMMARY_BUDGET_RATIO = 0.6

# File formats the ingestion pipeline accepts (case-insensitive).
SUPPORTED_DOC_EXTENSIONS = (
    ".pdf", ".docx", ".xlsx", ".pptx",
    ".txt", ".md", ".csv", ".tsv", ".html", ".htm", ".rtf",
)

# Non-PDF pseudo-pagination
PSEUDO_PAGE_CHARS = 3000

# Ingestion quality gates
PAGE_GARBAGE_THRESHOLD = 0.35
DOC_GARBAGE_RATIO = 0.6
EMBED_FAILURE_BREAKER = 10

# PDF table extraction caps
TABLE_MAX_ROWS_PER_TABLE = 80
TABLE_MAX_TOTAL_ROWS = 400


# ------------------------------------------------------------------
# Runtime overrides — lets the Settings UI change chat behaviour without
# editing this file. Values stored in the SQLite `settings` table win
# over the defaults above. Supported override keys:
#   chat_model, chat_num_ctx, chat_ctx_safety_margin,
#   chat_temperature, chat_num_predict
# ------------------------------------------------------------------
def _coerce_int(value, fallback):
    try:
        return int(str(value).strip())
    except Exception:
        return fallback


def _coerce_float(value, fallback):
    try:
        return float(str(value).strip())
    except Exception:
        return fallback


def get_chat_config():
    """Return the effective chat (RAG) config, merging DB overrides.

    Returns dict with: model, num_ctx, ctx_safety_margin, temperature,
    num_predict. Falls back to the module defaults if the DB is
    unreachable or a key is missing. This is intentionally lazy so
    `config.py` never creates a circular import with `storage.sqlite`.
    """
    defaults = {
        "model": RAG_MODEL,
        "num_ctx": NUM_CTX,
        "ctx_safety_margin": CTX_SAFETY_MARGIN,
        "temperature": GENERATION_TEMPERATURE,
        "num_predict": RAG_NUM_PREDICT,
    }
    try:
        from storage.sqlite import get_connection

        conn = get_connection()
        try:
            rows = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings").fetchall()}
        finally:
            conn.close()
    except Exception:
        return defaults

    out = dict(defaults)
    if rows.get("chat_model"):
        out["model"] = rows["chat_model"].strip() or defaults["model"]
    if rows.get("chat_num_ctx"):
        out["num_ctx"] = _coerce_int(rows["chat_num_ctx"], defaults["num_ctx"])
    if rows.get("chat_ctx_safety_margin"):
        out["ctx_safety_margin"] = _coerce_int(rows["chat_ctx_safety_margin"], defaults["ctx_safety_margin"])
    if rows.get("chat_temperature") is not None and rows.get("chat_temperature") != "":
        out["temperature"] = _coerce_float(rows["chat_temperature"], defaults["temperature"])
    if rows.get("chat_num_predict"):
        # empty string means "use model default"
        raw = rows["chat_num_predict"].strip()
        out["num_predict"] = _coerce_int(raw, defaults["num_predict"]) if raw else None
    return out
