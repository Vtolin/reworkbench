// Makalah generation pipeline — deterministic, human-supervised.
// The LLM never owns control flow: every LLM call is a pure function
// (fixed input -> fixed JSON output, no tools, no memory of other calls).
// Application code owns: retrieval, validation, loops, rendering.
// Pipeline: outline (Mode A, 1 call) -> human approve -> per-section loop
// (retrieve in code -> section call -> validate in code) -> PDF (print view).
//
// Phase 7: implementation split into cohesive modules; this barrel preserves
// the exact public surface previously provided by lib/wb/makalah.ts so all
// existing importers keep working unchanged.

export type {
  OutlineSubsection,
  OutlineChapter,
  MakalahOutline,
  TemplateConstraints,
  SourceSummary,
  SectionPassage,
  SectionCitation,
  SectionParagraph,
  SectionOutput,
  MakalahReference,
  QualityReport,
  RefineResult,
  OutlineContext,
  MakalahHybrid,
} from "./types";
export { SECTION_SALVAGE_MARKER, MAKALAH_HYBRID_DEFAULT } from "./types";

export {
  isMalformedReference,
  sectionFullText,
  countAiFilled,
  findRedundantPairs,
  buildNegativeList,
} from "./quality";

export {
  MAKALAH_SHARED_SYSTEM,
  buildOutlineUserPrompt,
  buildSectionUserPrompt,
} from "./prompts";

export { makalahStageLabels, makalahThinkBudget } from "./stages";

export { repairJson, parseOutlineJson, parseSectionJson } from "./json";

export {
  outlineSubLabel,
  findOutlineOverlaps,
  refineOutline,
  generateOutline,
} from "./outline";

export { getSourceSummaries, passageKey, retrieveForSection } from "./retrieval";

export {
  normalizeAliasCitation,
  stripLeakedCitations,
  cleanPassageForPrompt,
  stripTitleEchoes,
  containsGapLeak,
  hasCitationLeak,
  hasEmptyCitation,
} from "./citations";

export { generateSection } from "./generation";

export { validateSectionCitations, claimSupportCheck } from "./validation";

export { buildReferences, loadDocTitles } from "./references";

export type { HydratedDoc } from "../library";
