// Makalah section generation (two-phase drafting + bounded correction).
// Extracted verbatim from lib/wb/makalah.ts (Phase 7); behavior unchanged.
import type { InferenceSelection } from "../ask";
import { chatJson, parseSectionJson, stripFences } from "./json";
import { MAKALAH_SHARED_SYSTEM, buildSectionUserPrompt } from "./prompts";
import { makalahBudget, makalahThinkBudget, pickMakalahStage } from "./stages";
import { aliasPassages, containsGapLeak, hasCitationLeak, hasEmptyCitation, resolveAliases, stripLeakedCitations, stripTitleEchoes } from "./citations";
import { validateSectionCitations } from "./validation";
import type { OutlineContext, SectionOutput, SectionPassage } from "./types";
import { SECTION_SALVAGE_MARKER, type MakalahHybrid } from "./types";

export async function generateSection(
  input: {
    topic: string;
    chapter_title: string;
    subsection_number: string;
    subsection_title: string;
    language: string;
    citation_style: string;
    passages: SectionPassage[];
    target_length_words: number;
    /** Known source titles (id → title) for stripping title-echo leaks. */
    source_titles?: Record<string, string>;
    /** Document-level context (outline + already-drafted summaries + scope). */
    outline_context?: OutlineContext;
    /** Grounding mode for this section (default strict). */
    grounding?: MakalahHybrid;
    /** Sampling temperature (default 0 = deterministic; small values only on explicit retry). */
    temperature?: number;
  },
  sel: InferenceSelection,
  signal?: AbortSignal,
): Promise<SectionOutput> {
  const { provider, model } = pickMakalahStage(sel, sel.makalahSectionStage);
  const { aliased, toReal } = aliasPassages(input.passages);
  const echoTitles = Object.values(input.source_titles ?? {});
  const clean = (o: SectionOutput): SectionOutput => ({
    ...o,
    paragraphs: o.paragraphs.map((p) => ({
      ...p,
      text: stripTitleEchoes(stripLeakedCitations(p.text), echoTitles),
    })),
  });
  // Thinking lives ONLY here: outline and claim-check always run cold.
  // When on, drafting is two-phase (both fixed, app-controlled calls):
  //   1. deliberate — thinking enabled, num_predict == think budget (a HARD
  //      cap: Ollama stops generating at the cap, so the trace can never eat
  //      the answer). The trace is kept; any content is a best-effort bonus.
  //   2. answer — thinking disabled with the FULL answer cap, the trace
  //      injected as context. The answer can never starve, by construction.
  // If phase 1 already yields valid JSON content, it is used directly and
  // phase 2 is skipped. If phase 1 fails outright, we fall back to a single
  // cold call. Either way the JSON contract + alias/strip pipeline below holds.
  const thinkingOn = sel.makalahThinking ?? false;
  const thinkBudget = thinkingOn ? makalahThinkBudget(sel) : null;
  const answerCap = makalahBudget(sel);
  const answerTemp = input.temperature ?? 0;
  // Native <think> tags are an Ollama convention. Cloud models reason via
  // thinking_config and must never emit literal tags (the parser strips them).
  const thinkTags = provider.id === "ollama";
  const thinkLevel = sel.makalahThinkLevel ?? "low";
  // Ollama has no "minimal" level (400 on unknown think values) — closest is
  // a brief "low" trace. Cloud (Gemini 3) keeps "minimal" as closest-to-off.
  const deliberationLevel = provider.id === "ollama" && thinkLevel === "minimal" ? "low" : thinkLevel;
  const baseUser = buildSectionUserPrompt(
    {
      ...input,
      passages: aliased,
      full_outline: input.outline_context?.full_outline,
      prior_context: input.outline_context?.prior_summaries,
      scope_note: input.outline_context?.scope_note,
      negative_list: input.outline_context?.negative_list,
      is_last_chapter: input.outline_context?.is_last_chapter,
      grounding: input.grounding ?? "off",
    },
    thinkBudget,
    thinkTags,
  );
  const finish = (parsed: SectionOutput): SectionOutput =>
    clean(resolveAliases(parsed, toReal));
  // Salvage ONLY malformed-model-output failures (chatJson tags those with a
  // string `.raw`). Network / provider / auth errors must stay hard errors —
  // silently converting "Ollama offline" into a fake section would be a lie.
  const salvage = (e: unknown): SectionOutput => {
    // Stop/abort is user intent, never salvageable content.
    if (signal?.aborted) throw e;
    const raw = (e as { raw?: unknown }).raw;
    if (typeof raw !== "string") throw e;
    const text = stripTitleEchoes(
      stripLeakedCitations(stripFences(raw).trim()), echoTitles,
    ) || "(model returned empty output)";
    return {
      paragraphs: [{ text, citations: [] }],
      gaps:
        `${SECTION_SALVAGE_MARKER} The model did not return valid JSON even after a retry, ` +
        `so the raw text above is preserved as-is WITHOUT citations. Verify every claim ` +
        `against the retrieved passages manually before keeping this section.`,
    };
  };

  // One bounded correction retry for deterministic defects (unknown ids,
  // page mismatches, empty citations, citation leaks in prose, gap-leaks in
  // prose). The model gets its defects listed back and one chance to fix
  // them — still fully app-controlled (max 1 extra call, fixed prompt shape,
  // no autonomy). Never throws: a failed correction keeps the first draft
  // (only unparsable model output salvages, via salvage() at the call sites).
  const defectList = (out: SectionOutput): string[] => {
    const defects: string[] = [];
    const v = validateSectionCitations(out, input.passages);
    if (v.badIds.length) defects.push(`unknown source ids (not in retrieved passages): ${v.badIds.slice(0, 6).join(", ")}`);
    if (v.badPages.length) defects.push(`pages not present in retrieved passages: ${v.badPages.slice(0, 6).join(", ")}`);
    if (hasEmptyCitation(out)) defects.push('empty source key (renders as "[, N]")');
    const leaked = (out.paragraphs ?? []).find((p) => containsGapLeak(p.text));
    if (leaked) defects.push(`source-gap meta-sentence in paragraph text (belongs in "gaps", never in "text")`);
    return defects;
  };
  // Leak check runs on PARSED output before clean(): finish() strips leaks,
  // so checking the finished draft would always pass. A stripped leak still
  // ships readable text, but the correction reinforces the attribution rule.
  const rawHadLeak = (parsed: SectionOutput): boolean =>
    (parsed.paragraphs ?? []).some((p) => hasCitationLeak(p.text));
  const LEAK_DEFECT = `bracketed citation-shaped text inside paragraphs (aliases, bare numbers, years — attribution belongs ONLY in the "citations" array)`;
  const maybeCorrect = async (first: SectionOutput, prompt: string, firstHadLeak = false): Promise<SectionOutput> => {
    const defects = defectList(first);
    if (firstHadLeak) defects.push(LEAK_DEFECT);
    if (!defects.length || signal?.aborted) return first;
    const correction =
      `${prompt}\n\nCORRECTION — your previous draft had these defects:\n` +
      defects.map((d) => `- ${d}`).join("\n") +
      `\nFix them: cite ONLY aliases from the Valid aliases list with their shown page ` +
      `numbers (copy exactly, never invent pages); never write bracketed references, ` +
      `aliases, or years inside "text"; put source-gap commentary in "gaps", ` +
      `never in "text"; every paragraph needs at least one valid citation or an empty ` +
      `array. Output JSON only.`;
    try {
      const out = await chatJson(
        provider, model, MAKALAH_SHARED_SYSTEM, correction,
        sel.numCtx, answerCap, parseSectionJson, "Section correction", false,
        undefined, signal, answerTemp,
      );
      const second = finish(out);
      const secondDefects = defectList(second);
      if (rawHadLeak(out)) secondDefects.push(LEAK_DEFECT);
      // Keep whichever draft has fewer defects (never regress).
      return secondDefects.length < defects.length ? second : first;
    } catch (e) {
      // User stop must propagate — never convert an abort into a kept draft.
      if (signal?.aborted) throw e;
      return first;
    }
  };

  if (thinkBudget === null) {
    try {
      const out = await chatJson(
        provider, model, MAKALAH_SHARED_SYSTEM, baseUser,
        sel.numCtx, answerCap, parseSectionJson, "Section generation", false,
        undefined, signal, answerTemp,
      );
      return await maybeCorrect(finish(out), baseUser, rawHadLeak(out));
    } catch (e) {
      return salvage(e);
    }
  }

  let trace = "";
  try {
    const deliberation = await provider.chat(
      [
        { role: "system", content: MAKALAH_SHARED_SYSTEM },
        { role: "user", content: baseUser },
      ],
      {
        model, temperature: 0, numCtx: sel.numCtx, numPredict: thinkBudget,
        thinking: true, thinkLevel: deliberationLevel,
        thinkingBudget: thinkBudget,
        jsonMode: true,
        ...(signal ? { signal } : {}),
      },
    );
    const content = (deliberation.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (content) {
      try {
        const parsed = parseSectionJson(content);
        return await maybeCorrect(finish(parsed), baseUser, rawHadLeak(parsed));
      } catch {
        /* well-formed trace but unusable draft — deliberate below from trace */
      }
    }
    // Cloud parity: CloudProvider now returns a native `thinking` trace when
    // the proxy surfaces one; Ollama returns it directly. Either way the
    // trace is injected as context — never discarded.
    trace = (deliberation.thinking ?? "").trim();
  } catch (e) {
    if (signal?.aborted) throw e;
    trace = ""; // deliberation failed — cold fallback below
  }
  const finalUser = trace
    ? `${baseUser}\n\nYour earlier deliberation (follow it; do not repeat it, output JSON only):\n${trace.slice(0, (thinkBudget ?? 1024) * 3)}`
    : baseUser;
  try {
    const out = await chatJson(
      provider, model, MAKALAH_SHARED_SYSTEM, finalUser,
      sel.numCtx, answerCap, parseSectionJson, "Section generation", false,
      thinkBudget, signal, answerTemp,
    );
    return await maybeCorrect(finish(out), finalUser, rawHadLeak(out));
  } catch (e) {
    return salvage(e);
  }
}

// ---------------------------------------------------------------------------
// Validation — deterministic code (spec §6 steps 1–3)
// ---------------------------------------------------------------------------
