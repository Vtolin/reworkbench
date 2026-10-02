import type { SupabaseClient } from "@supabase/supabase-js";
import { chunkArray } from "@/lib/async/pool";
import { DOCUMENT_COLUMNS_SELECT } from "./library";

// Workspace export (Phase 5: scalability).
//
// The old export fetched whole tables with select("*") in single shots —
// documents rows carry a generated fts tsvector (KBs per row), so large
// libraries blew up memory and bandwidth. Now:
// - documents use DOCUMENT_COLUMNS_SELECT (fts excluded, like the library)
//   fetched in bounded range pages (1000 rows) up to the historical 5000 cap;
// - chat_messages use an explicit column list, resolved through the
//   workspace's chats in bounded batches as before;
// - other tables keep their historical select(*) + caps (small, unchanged);
// - above EXPORT_WARN_THRESHOLD_ROWS the UI warns and the download splits
//   into two parts (library tables / chats+messages) instead of one giant
//   file. Under the threshold the single-file shape is byte-identical in
//   keys to the old export.

export const EXPORT_PAGE_SIZE = 1000;
export const EXPORT_TABLE_CAP = 5000;
export const EXPORT_CHAT_CAP = 2000;
export const EXPORT_MESSAGE_CAP = 5000;
export const EXPORT_WARN_THRESHOLD_ROWS = 3000;

export const CHAT_MESSAGE_COLUMNS = "id, chat_id, role, content, metadata_json, created_at";

const EXPORT_TABLES = [
  "collections",
  "tags",
  "authors",
  "research_projects",
  "claims",
  "citations",
  "evidence_items",
  "annotations",
  "research_trail",
  "saved_searches",
  "chats",
];

export interface ExportPart {
  filename: string;
  data: Record<string, unknown>;
}

export interface WorkspaceExport {
  parts: ExportPart[];
  totalRows: number;
  warned: boolean;
  warning: string | null;
}

async function fetchDocumentsPaged(sb: SupabaseClient, ws: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let offset = 0; offset < EXPORT_TABLE_CAP; offset += EXPORT_PAGE_SIZE) {
    const { data } = await sb
      .from("documents")
      .select(DOCUMENT_COLUMNS_SELECT)
      .eq("workspace_id", ws)
      .order("created_at", { ascending: false })
      .range(offset, offset + EXPORT_PAGE_SIZE - 1);
    const page = (data ?? []) as unknown[];
    out.push(...page);
    if (page.length < EXPORT_PAGE_SIZE) break;
  }
  return out.slice(0, EXPORT_TABLE_CAP);
}

async function fetchChatMessages(sb: SupabaseClient, ws: string): Promise<unknown[]> {
  const { data: exportChats } = await sb.from("chats").select("id").eq("workspace_id", ws).limit(EXPORT_CHAT_CAP);
  const chatIds = ((exportChats ?? []) as Array<{ id: string }>).map((c) => c.id);
  const messages: unknown[] = [];
  for (const batch of chunkArray(chatIds)) {
    if (messages.length >= EXPORT_MESSAGE_CAP) break;
    const { data } = await sb
      .from("chat_messages")
      .select(CHAT_MESSAGE_COLUMNS)
      .in("chat_id", batch)
      .order("created_at")
      .limit(EXPORT_MESSAGE_CAP - messages.length);
    messages.push(...((data ?? []) as unknown[]));
  }
  return messages;
}

export async function buildWorkspaceExport(sb: SupabaseClient, ws: string): Promise<WorkspaceExport> {
  const short = ws.slice(0, 8);
  const stamped = new Date().toISOString();
  const documents = await fetchDocumentsPaged(sb, ws);
  const tables: Record<string, unknown[]> = { documents };
  for (const t of EXPORT_TABLES) {
    const { data } = await sb.from(t).select("*").eq("workspace_id", ws).limit(EXPORT_TABLE_CAP);
    tables[t] = (data ?? []) as unknown[];
  }
  const messages = await fetchChatMessages(sb, ws);
  const totalRows = Object.values(tables).reduce((n, rows) => n + rows.length, 0) + messages.length;
  const warned = totalRows > EXPORT_WARN_THRESHOLD_ROWS;
  const warning = warned
    ? `Large export (${totalRows} rows): download split into 2 parts.`
    : null;
  if (!warned) {
    return {
      parts: [
        {
          filename: `workbench-export-${short}.json`,
          data: { workspace_id: ws, exported_at: stamped, ...tables, chat_messages: messages },
        },
      ],
      totalRows,
      warned,
      warning,
    };
  }
  return {
    parts: [
      {
        filename: `workbench-export-${short}-part1-library.json`,
        data: { workspace_id: ws, exported_at: stamped, part: 1, ...tables },
      },
      {
        filename: `workbench-export-${short}-part2-chats.json`,
        data: { workspace_id: ws, exported_at: stamped, part: 2, chat_messages: messages },
      },
    ],
    totalRows,
    warned,
    warning,
  };
}
