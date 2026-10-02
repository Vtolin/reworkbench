import type { RealtimeEvent } from "@/lib/supabase/realtime";

// Directory resources shown by the Sidebar (collections + tags + stats) and
// the library page (collections + tags). Maps a realtime event to ONLY the
// resources it can have affected, so each event triggers exactly the
// refetch(es) it needs and nothing else.
//
// Document changes fan out to all three: the collections/tags lists embed
// per-list document_count badges (count RPCs, no status filter), and stats
// counts approved documents — one document INSERT/UPDATE/DELETE can move all
// of them. Collection/tag table changes touch only their own list. Member,
// chat and project events never touch directory data.
export type DirectoryResource = "collections" | "tags" | "stats";

export function resourcesForEvent(event: RealtimeEvent): DirectoryResource[] {
  switch (event) {
    case "document-uploaded":
    case "document-approved":
      return ["collections", "tags", "stats"];
    case "collection-changed":
      return ["collections"];
    case "tag-changed":
      return ["tags"];
    default:
      return [];
  }
}
