"""
Text-quality heuristics for the ingestion circuit breakers.

Highly corrupted PDFs can open successfully while their extracted text is
garbage: broken font maps produce runs of unrelated letters, undecodable
glyphs come back as replacement characters, and encrypted or mis-parsed
streams yield symbol soup. This module scores a text sample so ingestion
can decide "is this worth embedding, or am I about to feed garbage to the
embedding model and the 4B extraction model?"

The score is deliberately cheap and dependency-free:

- word_ratio: the fraction of alphabetic characters that sit inside
  plausible word runs (2-25 letters). Real prose scores ~0.85+. Garbage
  from font-map corruption usually becomes long unbroken letter runs or
  single scattered letters - both fall outside the 2-25 window and drag
  the ratio down.
- printable_ratio: the fraction of non-whitespace characters that are
  printable - replacement characters (\ufffd) and control bytes from
  undecodable streams drag this down.
- alpha_fraction: alphabetic characters as a fraction of non-whitespace.
  A page that is almost entirely numbers/symbols has no readable prose
  for a language model anyway.

assess_text_quality returns 0.0..1.0 (the product of the three signals,
weighted so that any one badly-failing signal tanks the score), and
is_likely_garbage applies config's PAGE_GARBAGE_THRESHOLD.
"""
import re

from config import PAGE_GARBAGE_THRESHOLD

# Plausible word runs: 2-25 letters. Single letters and >25-letter runs
# are both typical corruption signatures (font-map garbage, mojibake).
_WORD_RUN_RE = re.compile(r"[A-Za-z\u00c0-\u024f]{2,25}")

# A page with almost no alphabetic content has no prose for the models -
# even if it isn't "corrupt" in the byte sense (e.g. a pure symbol dump).
_MIN_ALPHA_FRACTION = 0.2


def assess_text_quality(text):
    """Score extracted text 0.0 (garbage) .. 1.0 (plausible prose)."""
    if not text or not isinstance(text, str):
        return 0.0

    alpha = 0
    nonspace = 0
    printable = 0
    for ch in text:
        if ch.isspace():
            continue
        nonspace += 1
        if ch.isalpha():
            alpha += 1
        if ch.isprintable():
            printable += 1

    if nonspace == 0:
        return 0.0

    alpha_fraction = alpha / nonspace
    if alpha_fraction < _MIN_ALPHA_FRACTION:
        return 0.0

    word_chars = sum(len(m.group(0)) for m in _WORD_RUN_RE.finditer(text))
    word_ratio = word_chars / alpha if alpha else 0.0
    printable_ratio = printable / nonspace

    return word_ratio * printable_ratio


def is_likely_garbage(text, threshold=None):
    """True if `text` scores below the garbage threshold. Callers use this
    to drop a page (or, at scale, a whole document) instead of embedding
    and chunking it."""
    threshold = PAGE_GARBAGE_THRESHOLD if threshold is None else threshold
    return assess_text_quality(text) < threshold
