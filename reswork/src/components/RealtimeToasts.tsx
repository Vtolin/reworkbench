"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "@/contexts/SessionContext";
import { subscribeWorkspace, type RealtimeEvent } from "@/lib/supabase/realtime";

interface Toast { id: number; text: string; }

export function RealtimeToasts() {
  const { workspace } = useSession();
  const [notes, setNotes] = useState<Toast[]>([]);
  const counterRef = useRef(0);
  // Pending auto-dismiss handles: cleared on unmount / workspace switch so
  // a stale timer can never setState on an unmounted tree or dismiss a
  // toast belonging to the next workspace.
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

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
        "collection-changed": "Collection updated",
        "tag-changed": "Tag updated",
      };
      const id = ++counterRef.current;
      setNotes((prev) => [...prev.slice(-4), { id, text: labels[event] }]);
      // Auto-dismiss after 4 seconds
      const timer = setTimeout(() => {
        setNotes((prev) => prev.filter((n) => n.id !== id));
      }, 4000);
      timersRef.current.push(timer);
    });
    return () => {
      unsub();
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current = [];
    };
  }, [workspace?.id]);

  if (notes.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2">
      {notes.map((n) => (
        <div key={n.id} className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 animate-fadeIn">
          {n.text}
        </div>
      ))}
    </div>
  );
}
