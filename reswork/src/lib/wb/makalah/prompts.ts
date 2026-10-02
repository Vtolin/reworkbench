// Makalah prompt builders + shared system prompt.
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.
import { cleanPassageForPrompt } from "./citations";
import type { MakalahHybrid, SectionPassage, SourceSummary, TemplateConstraints } from "./types";

export const MAKALAH_SHARED_SYSTEM =
  "You are a single-purpose text-generation function inside a document pipeline. " +
  "You do not plan, do not call tools, do not ask the user questions, and do not " +
  "decide what happens next in the pipeline — the calling application controls " +
  "that. You receive one well-defined input and must return exactly one " +
  "well-defined output in the exact schema requested. If the input is " +
  "insufficient to complete the task fully, do the best you can with what is " +
  "given and flag gaps explicitly in the output fields provided for that " +
  "purpose — never invent facts, sources, or citations to fill a gap.\n\n" +
  "JSON hygiene (mandatory): inside JSON strings, escape line breaks as \\n and " +
  "double quotes as \\\". Never use trailing commas. Numbers and booleans are " +
  "unquoted.\n\n" +
  "Output ONLY the requested JSON. No preamble, no markdown fences, no commentary " +
  "outside the JSON structure.";

// ---------------------------------------------------------------------------
// Provider + JSON helpers
// ---------------------------------------------------------------------------

export function buildOutlineUserPrompt(input: {
  topic: string;
  language: string;
  academic_level: string;
  source_summaries: SourceSummary[];
  template_constraints: TemplateConstraints;
}): string {
  const sources = input.source_summaries
    .map((s) => `- ${s.id} — ${s.title} — ${s.abstract_or_excerpt}`)
    .join("\n");
  const constraints = [
    `- Required top-level sections: ${input.template_constraints.required_top_level_sections.join("; ")}`,
    `- Min subsections per chapter: ${input.template_constraints.min_subsections_per_chapter}`,
    `- Max subsections per chapter: ${input.template_constraints.max_subsections_per_chapter}`,
  ].join("\n");
  return (
    `Topic: ${input.topic}\n` +
    `Language: ${input.language}\n` +
    `Academic level: ${input.academic_level}\n\n` +
    `Available sources (id — title — short excerpt):\n${sources || "(no sources provided)"}\n\n` +
    `Task: Propose a chapter/subsection outline for an academic paper (makalah) on ` +
    `this topic, grounded only in themes actually present in the sources above. ` +
    `Follow these structural constraints exactly:\n${constraints}\n\n` +
    `Chapter roles (generic, apply to any topic): the first chapter (Pendahuluan) ` +
    `covers background, problem, and scope — NO in-depth theory. The middle ` +
    `chapter(s) (Pembahasan) carry theories, analyses, and applications. The ` +
    `last chapter (Penutup) holds conclusions and suggestions only — no new ` +
    `material. Subsections must be mutually exclusive within AND across ` +
    `chapters: if two subsections could share a paragraph, split them again. ` +
    `Give each subsection a one-sentence "focus" (the single question it ` +
    `answers) and "must_not_cover" (topics owned by other subsections).\n\n` +
    `For each subsection, list which source ids plausibly support it (you are not ` +
    `writing content yet, only proposing structure and mapping likely evidence). ` +
    `Copy each source id EXACTLY as shown in the list above — paste the full ` +
    `string verbatim. Never abbreviate, renumber, shorten, or invent ids.\n\n` +
    `Return JSON only, in this schema (the likely_sources values below are ` +
    `PLACEHOLDERS showing shape only — always replace them with real ids ` +
    `pasted from the list above):\n` +
    `{"outline": [{"chapter_number": "BAB I", "chapter_title": "Pendahuluan", ` +
    `"subsections": [{"number": "1.1", "title": "Latar Belakang", ` +
    `"focus": "why this topic matters", "must_not_cover": ["detailed theory"], ` +
    `"likely_sources": ["<paste-exact-id-from-list-above>", "<paste-another-exact-id>"]}]}, ` +
    `{"chapter_number": "BAB III", "chapter_title": "Penutup", "synthesis_only": true, ` +
    `"subsections": [...]}], ` +
    `"coverage_notes": "any themes in the sources not reflected in the outline, or gaps"}\n\n` +
    `Mark the final chapter (Penutup — conclusions and suggestions only) with ` +
    `"synthesis_only": true: it must synthesize already-covered material and ` +
    `receive no new evidence.`
  );
}

/**
 * NOTE FOR FUTURE TUNERS:
 * There is an intentional design tension between MAKALAH_SHARED_SYSTEM ("never invent facts... to fill a gap")
 * and the 15/85 / 30/70 grounding blocks below ("use academic intelligence/insight when sources are thin").
 * The mitigations in place (mandatory empty citations [] on unsupported paragraphs, ai_filled surfaced in
 * the QualityReport, human verification before export) balance strict citation hygiene with drafting flow.
 */

/**
 * Base grounding rule per mode. Strict (off) forbids unsupported material;
 * hybrid modes budget a share of model intelligence but keep one hard rule:
 * no "source is missing" meta-sentences in paragraph text, and unsupported
 * paragraphs MUST carry an empty citations array (the quality report counts
 * them as model-bridged instead of pretending they are sourced).
 */
function groundingParagraph(mode: MakalahHybrid): string {
  if (mode === "off") {
    return (
      `You may ONLY use claims that are directly supported by the passages below. ` +
      `Do not introduce facts, statistics, or claims not present in these passages. ` +
      `If the passages are insufficient to write a complete section, write what is ` +
      `supported and note the gap — do not fill it with unsupported material.\n\n`
    );
  }
  const share = mode === "30/70" ? "~30%" : "~15%";
  return (
    `About ${mode === "30/70" ? "70%" : "85%"} of this section must be grounded in the passages below ` +
    `(factual claims cited by alias). The remaining ${share} may be model intelligence ` +
    `(transitions, narrative coherence${mode === "30/70" ? ", theoretical framing, cross-passage synthesis" : ""}) ` +
    `used to keep the section scholarly and complete when the passages are thin.\n\n`
  );
}

function groundingBlock(mode: MakalahHybrid, language: string): string {
  if (mode === "off") return "";
  const isID = language.toLowerCase().startsWith("id");
  if (isID) {
    return (
      `PENTING: Jangan pernah menulis kalimat seperti "tidak ditemukan dalam sumber", ` +
      `"tidak terdapat dalam kutipan", "sumber tidak memuat informasi", atau kalimat ` +
      `senada di dalam teks paragraf. Jika sumber kurang lengkap, gunakan kecerdasan ` +
      `dan wawasan akademik Anda untuk menulis pembahasan yang koheren, ilmiah, dan ` +
      `relevan dari sudut pandang yang paling didukung sumber — dan catat kekurangannya ` +
      `di "gaps" (dalam ${language}, untuk layar drafting penulis, tidak diterbitkan), ` +
      `bukan di "text". Paragraf tanpa dukungan passages WAJIB memakai citations kosong ` +
      `([]) agar laporan kualitas menandainya sebagai model-bridged.\n\n`
    );
  }
  return (
    `IMPORTANT: Never write phrases like "not found in the source", "not mentioned in the citations", ` +
    `"the sources do not provide information", or similar meta-commentary inside paragraph text. ` +
    `If the sources are incomplete, use your academic intelligence and insight to write a coherent, ` +
    `scholarly, and relevant discussion from the perspective best supported by the available sources — ` +
    `and record any gaps in "gaps" (in ${language}, for the author's drafting view only, not published), ` +
    `not in "text". Paragraphs without passage support MUST carry an empty citations array ` +
    `([]) so the quality report marks them as model-bridged.\n\n`
  );
}

export function buildSectionUserPrompt(input: {
  topic: string;
  chapter_title: string;
  subsection_number: string;
  subsection_title: string;
  language: string;
  citation_style: string;
  passages: SectionPassage[];
  target_length_words: number;
  /** Full outline ("1.1 T | 1.2 T | 2.1 T") so the model knows its neighbours. */
  full_outline?: string;
  /** Rolling summaries of already-drafted sections ("1.1 ...: <summary>"). */
  prior_context?: string;
  /** This subsection's scope guard (focus + must_not_cover from the outline). */
  scope_note?: string;
  /** Verbatim sentences from the most-similar drafted section: never repeat. */
  negative_list?: string;
  /** True for the closing chapter: synthesis contract, no new claims. */
  is_last_chapter?: boolean;
  /** Grounding mode: off = strict, 15/85 = coherence bridging, 30/70 = synthesis. */
  grounding?: MakalahHybrid;
}, thinkBudget: number | null = null, thinkTags = true): string {
  const passages =
    input.passages
      .map((p) => `[${p.source_id}, p.${p.page ?? "?"}] ${cleanPassageForPrompt(p.text)}`)
      .join("\n\n") || "(no passages retrieved)";
  // The exact alias range for this call — naming it kills invented S5/S6-style
  // citations at the source (the validator can only flag them afterwards).
  const validAliases = [...new Set(input.passages.map((p) => p.source_id))];
  const hasPrior = !!input.prior_context?.trim() || !!input.negative_list?.trim();
  const docFrame =
    (input.full_outline?.trim() ? `Full paper outline: ${input.full_outline.trim()}\n` : "") +
    // COVERED bullets read as constraints ("do not restate"), where the old
    // prose summaries ("already covered… build on them") primed small models
    // to echo the same sentences back. Number labels stay so the sanctioned
    // one-clause reference ("As discussed in 1.1…") remains possible.
    (input.prior_context?.trim()
      ? `COVERED — the following is already in the paper. Do not restate or paraphrase ` +
        `any of it; assume the reader has read it. One short clause like "As discussed ` +
        `in 1.1…" is allowed only when you must refer back:\n` +
        `${input.prior_context.trim()}\n`
      : "") +
    (input.negative_list?.trim()
      ? `The following sentences already exist verbatim earlier in this paper. ` +
        `Do not repeat or paraphrase them — write around them:\n` +
        `${input.negative_list.trim()}\n`
      : "") +
    (input.is_last_chapter
      ? `This is the closing chapter (Penutup): do not introduce new evidence or new ` +
        `claims. Each paragraph must COMBINE findings from at least two earlier sections ` +
        `into a new statement; do not reuse sentence structures or opening phrases from ` +
        `earlier sections.\n`
      : "") +
    (input.scope_note?.trim()
      ? `Your scope for THIS section only: ${input.scope_note.trim()} ` +
        `Content belonging to other subsections is out of scope even if the passages mention it.\n`
      : "") +
    // Step-shaped instruction for the deliberation phase: norms ("don't
    // re-explain") wash out under small thinking budgets, checklists survive.
    // Provider-agnostic: useful with or without native thinking, so it is
    // included whenever prior context exists (previously gated on thinking,
    // which left cloud-cold calls without it).
    (hasPrior
      ? `Deliberation instruction: first list which retrieved passages overlap the ` +
        `COVERED list above; plan this section only around the remaining passages.\n`
      : "");
  return (
    `Write section ${input.subsection_number} "${input.subsection_title}" of chapter ` +
    `"${input.chapter_title}" for an academic paper on "${input.topic}", in ${input.language}. ` +
    `Target length: about ${input.target_length_words} words.\n\n` +
    (docFrame ? `${docFrame}\n` : "") +
    (thinkBudget !== null && thinkTags ?
      `Thinking budget: you may spend AT MOST ${thinkBudget} tokens reasoning inside ` +
      `<think> tags before answering, then stop thinking and write the final JSON. ` +
      `Keep deliberation tight — a complete, valid answer matters more than long ` +
      `reasoning, and the total call is capped, so over-thinking truncates your answer.\n\n`
    : thinkBudget !== null ?
      // Cloud/native thinking: no <think> tags (the JSON parser strips them).
      // Reason natively within budget, then output JSON only.
      `Deliberation budget: reason natively within AT MOST ${thinkBudget} thinking tokens, ` +
      `then stop and write the final JSON with no reasoning preamble and no ` +
      `<think> tags. A complete, valid answer matters more than long reasoning.\n\n`
    : "") +
    groundingParagraph(input.grounding ?? "off") +
    groundingBlock(input.grounding ?? "off", input.language) +
    `Passages are labeled with short aliases (S1, S2, …). In the "citations" array, ` +
    `refer to passages ONLY by alias. ` +
    `Valid aliases for THIS section: ${validAliases.join(", ") || "(none — emit every paragraph with an empty citations array)"}. ` +
    `Never invent other aliases — unknown keys are rejected and the section is flagged.\n\n` +
    `Passages:\n${passages}\n\n` +
    `Attribution rule (strict): NEVER write a source alias, source id, author name, ` +
    `year, bracketed reference, or an empty placeholder like [] or [;] inside "text" — attribution belongs ONLY in the ` +
    `"citations" array. Bad: "…populasi termiskin (S1, p. 224)." ` +
    `Bad: "…model sangat besar []." ` +
    `Good: "…populasi termiskin."\n\n` +
    `Citation style: ${input.citation_style}. Every factual claim must carry an inline ` +
    `citation pointing to one of the passages above by alias. Always copy the page ` +
    `number shown with each passage into "page"; use null only when the passage ` +
    `shows none — never drop a shown page number. If a paragraph has no ` +
    `supporting passage, emit it with an empty citations array rather than citing an ` +
    `unrelated source.\n\n` +
    `Return JSON only:\n` +
    `{"paragraphs": [{"text": "...", "citations": [{"source_id": "S1", "page": 7}]}], ` +
    `"gaps": "in ${input.language}: note any part of the topic the given passages don't cover, or empty string (this note is for the author's drafting view only and is never published)"}`
  );
}
