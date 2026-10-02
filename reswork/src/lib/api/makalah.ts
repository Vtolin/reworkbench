// Feature API: makalah pipeline (deterministic; LLM as pure function).
// Thin delegates over lib/wb/makalah. Extracted verbatim from lib/api.ts
// (Phase 5); behavior unchanged.
import {
  generateOutline as wbMakalahOutline, generateSection as wbMakalahSection,
  retrieveForSection as wbMakalahRetrieve, getSourceSummaries as wbMakalahSources,
  buildReferences as wbMakalahReferences, claimSupportCheck as wbMakalahClaimCheck,
  type TemplateConstraints, type SourceSummary, type SectionPassage,
  type OutlineContext, type MakalahHybrid,
} from "../wb/makalah";
import { toSel } from "./inference";

export const makalahApi = {
  makalahSources: (document_ids: string[]) => wbMakalahSources(document_ids),
  makalahOutline: (body: { topic: string; language: string; academic_level: string; source_summaries: SourceSummary[]; template_constraints: TemplateConstraints }) =>
    wbMakalahOutline(body, toSel()),
  makalahRetrieve: (
    query: string,
    scopeIds: string[] | undefined,
    handlers?: { onStatus?: (stage: string, detail?: string) => void },
    topK = 8,
    keepTop = 4,
    excludeKeys?: string[],
  ): Promise<SectionPassage[]> => wbMakalahRetrieve(
    query, scopeIds, toSel(), topK, keepTop, handlers?.onStatus,
    excludeKeys?.length ? new Set(excludeKeys) : undefined,
  ),
  makalahSection: (body: { topic: string; chapter_title: string; subsection_number: string; subsection_title: string; language: string; citation_style: string; passages: SectionPassage[]; target_length_words: number; source_titles?: Record<string, string>; outline_context?: OutlineContext; grounding?: MakalahHybrid; temperature?: number }, signal?: AbortSignal) =>
    wbMakalahSection(body, toSel(), signal),
  makalahReferences: (document_ids: string[]) => wbMakalahReferences(document_ids),
  makalahClaimCheck: (paragraphText: string, citedPassages: SectionPassage[]) =>
    wbMakalahClaimCheck(paragraphText, citedPassages, toSel()),
};
