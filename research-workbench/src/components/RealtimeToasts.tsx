"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/contexts/SessionContext";
import { subscribeWorkspace, type RealtimeEvent } from "@/lib/supabase/realtime";

export function RealtimeToasts() {
  const { workspace } = useSession();
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => {
    if (!workspace) return;
    const unsub = subscribeWorkspace(workspace.id, (event: RealtimeEvent) => {
      const labels: Record<RealtimeEvent, string> = {
        "member-joined": "Member joined",
        "member-kicked": "Member removed",
        "document-uploaded": "Document uploaded",
        "document-approved": "Document approved",
        "chat-created": "Chat created",
        "chat-imported": "Chat imported",
        "project-changed": "Project changed",
      };
      setNotes((prev) => [...prev.slice(-4), labels[event]]);
    });
    return unsub;
  }, [workspace?.id]);

  if (notes.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 space-y-2">
      {notes.map((n, i) => (
        <div key={i} className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200">
          {n}
        </div>
      ))}
    </div>
  );
}
