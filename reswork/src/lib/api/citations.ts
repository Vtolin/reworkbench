// Feature API: citations (styles, rendering, serializations).
// Extracted verbatim from lib/api.ts (Phase 5); behavior unchanged.
import {
  docToCslItem, renderCitation, renderBibliography, bibtexEntry, risEntry,
  plainCitation, listStyles, setDefaultStyle, fetchStyleFromRepo, saveCustomStyle,
} from "../citations/csl";
import { getDocument } from "../wb/library";

export const citationsApi = {
  citationStyles: () => listStyles(),
  citationStyleDefault: async (style: string) => {
    setDefaultStyle(style);
    return { ok: true };
  },
  citationStyleCustom: async (xml: string) => {
    saveCustomStyle(xml);
    return { styles: (await listStyles()).styles };
  },
  citationStyleFetch: async (name: string) => {
    const style = await fetchStyleFromRepo(name);
    return { styles: (await listStyles()).styles, style };
  },
  citations: async (docId: string, style?: string) => {
    const doc = await getDocument(docId);
    const item = docToCslItem(doc);
    const [citation, bibliography] = await Promise.all([
      renderCitation(item, style).catch(() => plainCitation(doc)),
      renderBibliography([item], style).catch(() => [plainCitation(doc)]),
    ]);
    return {
      plain: plainCitation(doc),
      style: style ?? "apa",
      citation: bibliography[0] ?? citation,
      bibtex: bibtexEntry(doc),
      ris: risEntry(doc),
      csl_json: item,
    };
  },
};
