"use client";
import { useMakalah, draftTitle, draftProgress } from "@/contexts/MakalahContext";

export default function MakalahHistoryPanel({
  onOpen,
  onNew,
  onNavigate,
}: {
  onOpen: (id: string) => void;
  onNew: () => void;
  onNavigate?: () => void;
}) {
  const { drafts, activeId, deleteDraft } = useMakalah();
  const sorted = [...drafts].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="flex flex-col h-full bg-[#0a0a0a]">
      <div className="p-2 sm:p-3 border-b border-[#2f2f2f]">
        <button
          onClick={() => { onNew(); onNavigate?.(); }}
          className="w-full rounded-xl bg-white text-black py-2 sm:py-2.5 text-[13px] sm:text-sm font-medium hover:bg-[#ececec]"
        >
          + New makalah
        </button>
        <div className="mt-2 text-[11px] text-[#5f5f5f] text-center">
          Drafts autosave on this device — refresh-safe.
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-1 sm:p-2 space-y-1 no-scrollbar">
        {sorted.length === 0 && (
          <div className="text-xs text-[#5f5f5f] p-2 sm:p-3 text-center">No makalah yet</div>
        )}
        {sorted.map((d) => {
          const { done, total } = draftProgress(d);
          return (
            <div
              key={d.id}
              onClick={() => { onOpen(d.id); onNavigate?.(); }}
              className={`group rounded-xl px-2 sm:px-3 py-2 sm:py-2.5 cursor-pointer border ${d.id === activeId ? "bg-[#212121] border-[#2f2f2f]" : "border-transparent hover:bg-[#171717]"}`}
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-[#8e8e8e] shrink-0">✎</span>
                <span className="text-[13px] sm:text-sm truncate flex-1 text-[#ececec]">{draftTitle(d)}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteDraft(d.id); }}
                  className="opacity-0 group-hover:opacity-100 text-[#5f5f5f] hover:text-red-400 text-xs px-1"
                  title="Delete draft"
                  aria-label="Delete draft"
                >
                  ✕
                </button>
              </div>
              <div className="text-[11px] text-[#5f5f5f] mt-0.5">
                {total ? `${done}/${total} sections` : "setup"} • {new Date(d.updatedAt).toLocaleDateString()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
