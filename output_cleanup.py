r"""
Output cleanup: a safety-net pass that makes model-generated summaries and
answers readable by plain humans and plain markdown readers, plus LaTeX
math normalization for multi-format rendering (terminal / markdown / HTML
/ PDF).

Two layers, both deterministic (no model involved):

1. normalize_latex_symbols(): converts basic LaTeX math commands into
   readable Unicode/ASCII - \rightarrow -> "->", \approx -> "~=", and
   structural commands (\frac{a}{b} -> "a/b", \sqrt{x} -> "sqrt(x)",
   x^{2} -> "x^2"). Pure formatting; the underlying content is untouched,
   so it is safe to run even on verbatim source excerpts.

2. sanitize_model_output(): the full cleanup for GENERATED text - the
   LaTeX normalization above, plus removal of LaTeX fences ($...$),
   literal "\n" escapes, and internal attribution tags ([THIS WORK] /
   [CITED]) that belong to the extraction stage, not the final narrative.

The prompts already ask for plain readable prose; this is the safety net
for what still leaks through.
"""
import re

# ---------------------------------------------------------------------
# LaTeX -> readable text (shared by both layers)
# ---------------------------------------------------------------------
# Escaped punctuation first (runs before the word-command table, and their
# backslash forms would otherwise not be recognizable). Plain string
# replacements, so each pattern is exactly "backslash + char".
_LATEX_ESCAPES = [
    ("\\$", "$"), ("\\%", "%"), ("\\#", "#"), ("\\&", "&"),
    ("\\{", "{"), ("\\}", "}"), ("\\_", "_"),
]

# Structural commands: braces-based constructs get a readable rewrite.
# Deliberately shallow ([^{}]* only) - nested \frac{\frac{..}{..}}{..}
# stays untouched rather than being mangled.
_LATEX_STRUCTURAL = [
    (re.compile(r"\\frac\{([^{}]*)\}\{([^{}]*)\}"), r"\1/\2"),
    (re.compile(r"\\sqrt\{([^{}]*)\}"), r"sqrt(\1)"),
    (re.compile(r"\\text\{([^{}]*)\}"), r"\1"),
    (re.compile(r"\^\{([^{}]*)\}"), r"^\1"),   # x^{2} -> x^2
    (re.compile(r"_\{([^{}]*)\}"), r"_\1"),    # x_{i} -> x_i
    (re.compile(r"\\quad\b|\\qquad\b"), " "),
]

# Word-command symbol table. \b so "\\to" never matches inside "\\top",
# "\\le" inside "\\leq", "\\in" inside "\\int", etc. Longer names are
# listed first so the more specific spelling always wins where boundaries
# don't already disambiguate.
_LATEX_SYMBOLS = [
    (r"\\leftrightarrow\b", "\u2194"), (r"\\Leftrightarrow\b", "\u21d4"),
    (r"\\rightarrow\b", "\u2192"), (r"\\Rightarrow\b", "\u21d2"),
    (r"\\leftarrow\b", "\u2190"), (r"\\Leftarrow\b", "\u21d0"),
    (r"\\uparrow\b", "\u2191"), (r"\\downarrow\b", "\u2193"),
    (r"\\to\b", "\u2192"),
    (r"\\pm\b", "\u00b1"), (r"\\mp\b", "\u2213"),
    (r"\\times\b", "\u00d7"), (r"\\div\b", "\u00f7"), (r"\\cdot\b", "\u00b7"),
    (r"\\ast\b", "\u2217"), (r"\\star\b", "\u2606"), (r"\\circ\b", "\u2218"),
    (r"\\bullet\b", "\u2022"), (r"\\oplus\b", "\u2295"), (r"\\otimes\b", "\u2297"),
    (r"\\leq\b", "\u2264"), (r"\\le\b", "\u2264"),
    (r"\\geq\b", "\u2265"), (r"\\ge\b", "\u2265"),
    (r"\\neq\b", "\u2260"), (r"\\ne\b", "\u2260"),
    (r"\\approx\b", "\u2248"), (r"\\sim\b", "\u223c"),
    (r"\\simeq\b", "\u2243"), (r"\\cong\b", "\u2245"),
    (r"\\equiv\b", "\u2261"), (r"\\propto\b", "\u221d"),
    (r"\\perp\b", "\u22a5"), (r"\\parallel\b", "\u2225"),
    (r"\\in\b", "\u2208"), (r"\\notin\b", "\u2209"),
    (r"\\subseteq\b", "\u2286"), (r"\\supseteq\b", "\u2287"),
    (r"\\subset\b", "\u2282"), (r"\\supset\b", "\u2283"),
    (r"\\cup\b", "\u222a"), (r"\\cap\b", "\u2229"),
    (r"\\emptyset\b", "\u2205"), (r"\\forall\b", "\u2200"),
    (r"\\exists\b", "\u2203"), (r"\\neg\b", "\u00ac"),
    (r"\\land\b", "\u2227"), (r"\\lor\b", "\u2228"),
    (r"\\infty\b", "\u221e"), (r"\\partial\b", "\u2202"),
    (r"\\nabla\b", "\u2207"), (r"\\sum\b", "\u2211"), (r"\\prod\b", "\u220f"),
    (r"\\int\b", "\u222b"), (r"\\ell\b", "\u2113"), (r"\\hbar\b", "\u210f"),
    (r"\\ldots\b", "\u2026"), (r"\\cdots\b", "\u22ef"), (r"\\dots\b", "\u2026"),
    # Greek (the common set - lowercase, then uppercase)
    (r"\\alpha\b", "\u03b1"), (r"\\beta\b", "\u03b2"),
    (r"\\gamma\b", "\u03b3"), (r"\\delta\b", "\u03b4"),
    (r"\\epsilon\b", "\u03b5"), (r"\\varepsilon\b", "\u03b5"),
    (r"\\zeta\b", "\u03b6"), (r"\\eta\b", "\u03b7"),
    (r"\\theta\b", "\u03b8"), (r"\\iota\b", "\u03b9"),
    (r"\\kappa\b", "\u03ba"), (r"\\lambda\b", "\u03bb"),
    (r"\\mu\b", "\u03bc"), (r"\\nu\b", "\u03bd"),
    (r"\\xi\b", "\u03be"), (r"\\pi\b", "\u03c0"),
    (r"\\rho\b", "\u03c1"), (r"\\sigma\b", "\u03c3"),
    (r"\\tau\b", "\u03c4"), (r"\\phi\b", "\u03c6"), (r"\\varphi\b", "\u03c6"),
    (r"\\chi\b", "\u03c7"), (r"\\psi\b", "\u03c8"), (r"\\omega\b", "\u03c9"),
    (r"\\Gamma\b", "\u0393"), (r"\\Delta\b", "\u0394"),
    (r"\\Theta\b", "\u0398"), (r"\\Lambda\b", "\u039b"),
    (r"\\Xi\b", "\u039e"), (r"\\Pi\b", "\u03a0"),
    (r"\\Sigma\b", "\u03a3"), (r"\\Phi\b", "\u03a6"),
    (r"\\Psi\b", "\u03a8"), (r"\\Omega\b", "\u03a9"),
]

# Inline/display math delimiters: strip the delimiters, keep the content.
# Paired $ only - a lone "$500" (currency) has no closing dollar, so it is
# deliberately left untouched.
_MATH_PAIR_RE = re.compile(r"\${1,2}([^$]+?)\${1,2}", re.DOTALL)

_TAG_RE = re.compile(r"\[\s*(?:THIS WORK|CITED)\s*\]", re.IGNORECASE)

_LITERAL_NEWLINE_RE = re.compile(r"(?<!\\)\\n")


def normalize_latex_symbols(text):
    """Convert LaTeX math commands to readable Unicode/plain text.

    Safe for VERBATIM source excerpts: it only rewrites notation, never
    content (no tag stripping, no fence removal, no whitespace changes).
    Returns the input unchanged if there's nothing to convert."""
    if not text:
        return text

    for pattern, replacement in _LATEX_ESCAPES:
        text = text.replace(pattern, replacement)
    for pattern, replacement in _LATEX_STRUCTURAL:
        text = pattern.sub(replacement, text)
    for pattern, symbol in _LATEX_SYMBOLS:
        text = re.sub(pattern, symbol, text)
    return text


def sanitize_model_output(text):
    """Full cleanup for GENERATED text: preserves LaTeX delimiters for
    frontend KaTeX rendering, while still cleaning literal "\\n" escapes
    and internal [THIS WORK]/[CITED] tags. Safe to call on any text."""
    if not text:
        return text

    # literal \n escapes -> real newlines (a generation artifact, most
    # common in statistics-heavy passages)
    text = _LITERAL_NEWLINE_RE.sub("\n", text)

    # Preserve LaTeX math delimiters ($...$, $$...$$, \(...\), \[...\]) for KaTeX.
    # Only normalize LaTeX commands that are outside math mode and would
    # otherwise be unreadable in plain text fallback. For now, we keep
    # math intact and only clean up stray symbols that are clearly not in math.
    # To avoid breaking LaTeX, we selectively normalize only when not inside $ delimiters.
    # Simple approach: split by math delimiters, normalize only non-math parts.
    # For now, keep full text as-is except for tag cleanup, since frontend handles LaTeX.
    
    # internal extraction tags must never reach the reader
    text = _TAG_RE.sub("", text)

    # tidy the artifacts left behind ("... [THIS WORK]." -> "... .")
    text = re.sub(r"\s+\.", ".", text)
    text = re.sub(r"[ ]{2,}", " ", text)
    return text.strip()
