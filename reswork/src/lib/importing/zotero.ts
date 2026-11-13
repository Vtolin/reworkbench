import type { ImportRecord } from "./parsers";

export type ZoteroLibraryType = "users" | "groups";

export interface ZoteroSyncTarget {
  libraryType: ZoteroLibraryType;
  libraryId: string;
  apiKey?: string;
  collectionKey?: string;
  limit?: number;
}

export interface ZoteroCreator {
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface ZoteroRawItem {
  key?: string;
  data?: {
    itemType?: string;
    title?: string;
    creators?: ZoteroCreator[];
    date?: string;
    DOI?: string;
    publicationTitle?: string;
    bookTitle?: string;
    proceedingsTitle?: string;
    journalAbbreviation?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    publisher?: string;
    abstractNote?: string;
    url?: string;
    collections?: string[];
  };
}

const NUMERIC_ID_RE = /^\d{1,12}$/;
const COLLECTION_KEY_RE = /^[A-Za-z0-9]{4,16}$/;
const YEAR_RE = /\b(1[5-9]\d{2}|20\d{2}|2100)\b/;

export function validateZoteroTarget(target: ZoteroSyncTarget): {
  libraryType: ZoteroLibraryType;
  libraryId: string;
  apiKey?: string;
  collectionKey?: string;
  limit: number;
} {
  if (target.libraryType !== "users" && target.libraryType !== "groups") {
    throw new Error("Library type must be 'users' or 'groups'");
  }
  const libraryId = target.libraryId.trim();
  if (!NUMERIC_ID_RE.test(libraryId)) {
    throw new Error("Zotero library ID must be a numeric user or group ID");
  }
  const collectionKey = target.collectionKey?.trim() || undefined;
  if (collectionKey && !COLLECTION_KEY_RE.test(collectionKey)) {
    throw new Error("Zotero collection key must be 4-16 alphanumeric characters");
  }
  const apiKey = target.apiKey?.trim() || undefined;
  const limit = Math.max(1, Math.min(target.limit ?? 200, 200));
  return { libraryType: target.libraryType, libraryId, apiKey, collectionKey, limit };
}

export function parseZoteroYear(date?: string): number | null {
  if (!date) return null;
  const match = YEAR_RE.exec(date);
  return match ? Number(match[1]) : null;
}

export function cleanZoteroDoi(raw?: string): string | null {
  if (!raw) return null;
  const trimmed = raw
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "");
  return trimmed || null;
}

export function zoteroItemToImportRecord(
  item: ZoteroRawItem,
  collectionNamesByKey?: ReadonlyMap<string, string>
): ImportRecord | null {
  const data = item.data;
  if (!data) return null;
  const itemType = (data.itemType ?? "").toLowerCase();
  if (itemType === "attachment" || itemType === "note" || itemType === "annotation") {
    return null;
  }

  const authors = (data.creators ?? [])
    .map((c) => {
      if (c.name?.trim()) return c.name.trim();
      const parts = [c.firstName?.trim(), c.lastName?.trim()].filter(Boolean);
      return parts.join(" ");
    })
    .filter(Boolean);

  const collections = (data.collections ?? [])
    .map((k) => collectionNamesByKey?.get(k) ?? k)
    .filter(Boolean);

  return {
    title: data.title?.trim() || null,
    authors,
    year: parseZoteroYear(data.date),
    doi: cleanZoteroDoi(data.DOI),
    journal:
      data.publicationTitle?.trim() ||
      data.proceedingsTitle?.trim() ||
      data.bookTitle?.trim() ||
      data.journalAbbreviation?.trim() ||
      null,
    volume: data.volume?.trim() || null,
    issue: data.issue?.trim() || null,
    pages: data.pages?.trim() || null,
    publisher: data.publisher?.trim() || null,
    abstract: data.abstractNote?.trim() || null,
    rawKey: item.key ?? null,
    collections,
  };
}

export async function fetchZoteroItems(
  target: ZoteroSyncTarget,
  fetchImpl: typeof fetch = fetch
): Promise<ImportRecord[]> {
  const clean = validateZoteroTarget(target);
  const headers: Record<string, string> = {
    "Zotero-API-Version": "3",
    Accept: "application/json",
  };
  if (clean.apiKey) {
    headers["Zotero-API-Key"] = clean.apiKey;
  }

  const basePath = `https://api.zotero.org/${clean.libraryType}/${clean.libraryId}`;
  const collectionNames = new Map<string, string>();
  try {
    const colRes = await fetchImpl(`${basePath}/collections?limit=100`, { headers });
    if (colRes.ok) {
      const colRows = (await colRes.json()) as Array<{ key?: string; data?: { name?: string } }>;
      for (const row of colRows) {
        if (row.key && row.data?.name) collectionNames.set(row.key, row.data.name);
      }
    }
  } catch {
    // Collection name lookup is best-effort
  }

  const itemsPath = clean.collectionKey
    ? `${basePath}/collections/${clean.collectionKey}/items/top`
    : `${basePath}/items/top`;

  const collected: ImportRecord[] = [];
  const pageSize = Math.min(100, clean.limit);

  for (let start = 0; collected.length < clean.limit; start += pageSize) {
    const url = `${itemsPath}?format=json&limit=${pageSize}&start=${start}`;
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      throw new Error(`Zotero API error (${res.status}): check library ID, visibility, or read-only API key`);
    }
    const rawItems = (await res.json()) as ZoteroRawItem[];
    if (!rawItems.length) break;

    for (const item of rawItems) {
      const record = zoteroItemToImportRecord(item, collectionNames);
      if (record) collected.push(record);
      if (collected.length >= clean.limit) break;
    }
    if (rawItems.length < pageSize) break;
  }

  return collected;
}

export function buildBookmarkletHref(appOrigin: string): string {
  const safeOrigin = appOrigin.replace(/\/+$/, "");
  const code = `(()=>{var d=document,q=(s)=>d.querySelector(s)?.getAttribute('content')||'',doi=q('meta[name="citation_doi"]')||q('meta[name="dc.Identifier"]')||'',t=q('meta[name="citation_title"]')||d.title||'';window.open(${JSON.stringify(safeOrigin)}+'/upload?doi='+encodeURIComponent(doi)+'&title='+encodeURIComponent(t)+'&url='+encodeURIComponent(location.href),'_blank');})();`;
  return `javascript:${code}`;
}
