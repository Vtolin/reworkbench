"""
Ollama-only LLM + embeddings client.

All pipeline roles (RAG/chat, map, reduce, synthesis, doc-type
classification, embeddings) run against a local Ollama daemon
(default http://localhost:11434). Each role carries its own model
tag from config.py; Ollama loads models on demand per request.

Ollama-specific per-request options:
- num_ctx: KV-cache / context window for this call (see config.NUM_CTX).
- num_predict: max tokens to generate (maps to `num_predict` in Ollama).
- think: when True, enables the model's native reasoning mode via
  Ollama's `think` flag (needed for Qwen3/DeepSeek) and folds the
  `thinking` field into <think> tags so extraction is uniform.
"""

from config import THINKING_AVAILABLE  # always True in Ollama-only setup


def chat(model, messages, num_ctx=None, num_predict=None, temperature=None, thinking=False, provider=None, **_kw):
    """Return the assistant's reply text for a chat request.

    `messages` is a list of {"role": ..., "content": ...} dicts.
    `thinking` enables reasoning mode (Ollama `think` flag).
    `provider` is accepted for backwards compatibility but ignored
    (only Ollama is supported).
    """
    if provider is not None and provider != "ollama":
        raise ValueError(f"Unsupported provider {provider!r} — only 'ollama' is supported")
    return _ollama_chat(model, messages, num_ctx, num_predict, temperature, thinking=thinking)


def _ollama_chat(model, messages, num_ctx, num_predict, temperature, thinking=False):
    import ollama

    options = {}
    if temperature is not None:
        options["temperature"] = temperature
    if num_ctx is not None:
        options["num_ctx"] = num_ctx
    if num_predict is not None:
        options["num_predict"] = num_predict

    response = ollama.chat(model=model, messages=messages, think=bool(thinking), options=options)
    msg = _response_message(response)
    content = _msg_field(msg, "content") or ""
    # Non-streaming Ollama returns reasoning in a separate `thinking` field.
    # Fold it into <think> tags so the caller's extraction is uniform with
    # the streaming path — otherwise the reasoning is silently dropped.
    if thinking:
        t = _msg_field(msg, "thinking") or ""
        if t and "<think>" not in content:
            content = f"<think>{t}</think>\n{content}"
    return content


def _response_message(response):
    """Extract the message object from an Ollama chat response, supporting
    both dict-style (older client) and attribute-style (newer pydantic
    ChatResponse) shapes."""
    if response is None:
        return {}
    if isinstance(response, dict):
        return response.get("message") or {}
    msg = getattr(response, "message", None)
    if msg is not None:
        return msg
    try:
        return response["message"]
    except Exception:
        return {}


def _msg_field(msg, name):
    if msg is None:
        return ""
    if isinstance(msg, dict):
        return msg.get(name) or ""
    val = getattr(msg, name, None)
    if val:
        return val
    try:
        return msg[name] or ""
    except Exception:
        return ""


def chat_stream(model, messages, num_ctx=None, num_predict=None, temperature=None, thinking=False, on_status=None, provider=None, **_kw):
    """Yield raw text deltas (including <think> tags) for streaming.

    `on_status(stage, detail=None)` receives progress callbacks:
      - "processing_prompt": request in flight; model tokenizing/prefill.
      - "generating": first token arrived.
    `provider` is accepted for backwards compatibility but ignored.
    """
    if provider is not None and provider != "ollama":
        raise ValueError(f"Unsupported provider {provider!r} — only 'ollama' is supported")
    yield from _ollama_chat_stream(model, messages, num_ctx, num_predict, temperature, thinking=thinking, on_status=on_status)


def _ollama_chat_stream(model, messages, num_ctx, num_predict, temperature, thinking=False, on_status=None):
    import ollama

    options = {}
    if temperature is not None:
        options["temperature"] = temperature
    if num_ctx is not None:
        options["num_ctx"] = num_ctx
    if num_predict is not None:
        options["num_predict"] = num_predict

    if on_status:
        on_status("processing_prompt")
    stream = ollama.chat(model=model, messages=messages, think=bool(thinking), options=options, stream=True)
    thinking_open = False
    first = True
    for chunk in stream:
        msg = _response_message(chunk)
        # Ollama streams thinking in a separate field when think=True
        t = _msg_field(msg, "thinking") or ""
        c = _msg_field(msg, "content") or ""
        if first and (t or c):
            first = False
            if on_status:
                on_status("generating")
        if t:
            if not thinking_open:
                yield "<think>"
                thinking_open = True
            yield t
        if c:
            if thinking_open:
                yield "</think>\n"
                thinking_open = False
            yield c
    if thinking_open:
        yield "</think>\n"


def make_embeddings(model, provider="ollama"):
    """Return a LangChain Embeddings instance (Ollama-only).

    `provider` is accepted for backwards compatibility but must be
    "ollama" if supplied.
    """
    if provider != "ollama":
        raise ValueError(f"Unsupported provider {provider!r} — only 'ollama' is supported")
    from langchain_ollama import OllamaEmbeddings

    return OllamaEmbeddings(model=model)
