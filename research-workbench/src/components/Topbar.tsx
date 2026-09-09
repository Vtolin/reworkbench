"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function Topbar({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  const [health, setHealth] = useState<any>(null);
  useEffect(()=>{ api.health().then(setHealth).catch(()=>{}); },[]);
  return (
    <div className="sticky top-[56px] mt-[56px] lg:top-0 lg:mt-0 z-10 backdrop-blur bg-black/80 border-b border-[#2f2f2f]">
      <div className="px-4 lg:px-6 py-4 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <h1 className="text-lg lg:text-xl font-semibold tracking-tight text-white">{title}</h1>
          {subtitle && <p className="text-sm text-[#8e8e8e] truncate">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2 lg:gap-3 shrink-0">
          {health && (
            <div className="hidden md:flex items-center gap-2 text-xs">
              <span className={`h-2 w-2 rounded-full ${health.chroma_status==='ready' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              <span className="text-[#8e8e8e] hidden xl:inline">{health.documents} docs • {health.chroma_chunks} chunks • {health.chroma_status}</span>
            </div>
          )}
          {actions}
        </div>
      </div>
    </div>
  );
}
