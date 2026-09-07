"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useMobile } from "@/components/MobileShell";
import { useSession } from "@/contexts/SessionContext";
import { createClient } from "@/lib/supabase/client";

const NAV = [
  { href: "/", label: "Library", icon: "◧", desc: "All papers" },
  { href: "/search", label: "Search", icon: "⌕", desc: "Hybrid retrieval" },
  { href: "/research", label: "Research", icon: "✦", desc: "Ask & compare" },
  { href: "/projects", label: "Projects", icon: "⬢", desc: "Workspaces" },
  { href: "/chats", label: "Chats", icon: "◭", desc: "Published results" },
  { href: "/upload", label: "Upload", icon: "↑", desc: "Ingest" },
  { href: "/settings", label: "Settings", icon: "⚙", desc: "Models & keys" },
];

export default function Sidebar() {
  const path = usePathname();
  const router = useRouter();
  const { open, setOpen, collapsed, setCollapsed } = useMobile();
  const { workspace, user } = useSession();
  const [collections, setCollections] = useState<any[]>([]);
  const [tags, setTags] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);

  const load = () => {
    api.collections().then(setCollections).catch(()=>{});
    api.tags().then(setTags).catch(()=>{});
    api.stats().then(setStats).catch(()=>{});
  };
  useEffect(()=>{ load(); const id=setInterval(load, 5000); return ()=>clearInterval(id); },[]);

  const signOut = async () => {
    await createClient().auth.signOut();
    router.push("/login");
  };

  return (
    <>
      {/* mobile top bar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-20 flex items-center gap-3 px-4 py-3 bg-black border-b border-[#2f2f2f]">
        <button onClick={()=>setOpen(!open)} className="h-9 w-9 grid place-items-center rounded-xl bg-[#212121] border border-[#2f2f2f] text-[#ececec]">
          <span className="text-lg leading-none">≡</span>
        </button>
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-white text-black grid place-items-center font-semibold">◐</div>
          <div className="text-sm font-semibold tracking-tight">Research Workbench</div>
        </div>
        <div className="ml-auto text-xs text-[#8e8e8e]">{stats?.total ?? "—"} docs</div>
      </div>

      <aside className={`
        fixed lg:static left-0 bottom-0 top-[56px] lg:top-0 z-40 shrink-0 border-r border-[#2f2f2f] bg-[#0a0a0a] flex flex-col
        transition-all duration-200 lg:translate-x-0 lg:h-screen
        ${open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        ${collapsed ? "lg:w-[72px]" : "w-[280px] max-w-[85vw] lg:w-[280px] lg:max-w-none"}
      `}>
        <div className={`px-3 py-4 border-b border-[#2f2f2f] hidden lg:flex items-center gap-3 ${collapsed ? "justify-center px-2" : "px-5"}`}>
          {!collapsed ? (
            <>
              <div className="h-9 w-9 rounded-xl bg-white text-black grid place-items-center font-semibold tracking-tight shrink-0">◐</div>
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold tracking-tight leading-none text-white truncate">Research Workbench</div>
                <div className="text-[11px] text-[#8e8e8e] truncate">{workspace?.name ?? "Shared"} • {workspace?.role ?? "…"}</div>
              </div>
              <button
                onClick={()=>setCollapsed(true)}
                className="h-7 w-7 grid place-items-center rounded-lg bg-[#171717] border border-[#2f2f2f] text-[#8e8e8e] hover:text-white hover:bg-[#212121] shrink-0"
                title="Collapse sidebar"
              >‹</button>
            </>
          ) : (
            <button
              onClick={()=>setCollapsed(false)}
              className="h-9 w-9 rounded-xl bg-white text-black grid place-items-center font-semibold shrink-0"
              title="Expand sidebar"
            >◐</button>
          )}
        </div>
        {collapsed && (
          <button
            onClick={()=>setCollapsed(false)}
            className="hidden lg:grid h-7 w-7 mx-auto mt-2 place-items-center rounded-lg bg-[#171717] border border-[#2f2f2f] text-[#8e8e8e] hover:text-white shrink-0"
            title="Expand sidebar"
          >›</button>
        )}

        {!collapsed && stats && (
          <div className="hidden lg:grid mt-3 mx-5 grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-[#171717] border border-[#2f2f2f] py-2">
              <div className="text-[11px] text-[#8e8e8e] uppercase tracking-widest">Docs</div>
              <div className="text-sm font-semibold text-white">{stats.total}</div>
            </div>
            <div className="rounded-lg bg-[#171717] border border-[#2f2f2f] py-2">
              <div className="text-[11px] text-[#8e8e8e] uppercase tracking-widest">Colls</div>
              <div className="text-sm font-semibold text-white">{collections.length}</div>
            </div>
            <div className="rounded-lg bg-[#171717] border border-[#2f2f2f] py-2">
              <div className="text-[11px] text-[#8e8e8e] uppercase tracking-widest">Tags</div>
              <div className="text-sm font-semibold text-white">{tags.length}</div>
            </div>
          </div>
        )}
        {collapsed && stats && (
          <div className="hidden lg:flex flex-col items-center gap-1 mt-3">
            <div className="text-[10px] text-[#5f5f5f] uppercase tracking-widest">Docs</div>
            <div className="text-sm font-semibold text-white">{stats.total}</div>
          </div>
        )}

        <nav className={`py-3 space-y-1 ${collapsed ? "px-2" : "px-3"}`}>
          {NAV.map(n => {
            const active = path === n.href || (n.href !== "/" && path.startsWith(n.href));
            if (collapsed) {
              return (
                <Link key={n.href} href={n.href} onClick={()=>setOpen(false)} title={`${n.label} — ${n.desc}`} className={`flex justify-center rounded-xl p-2.5 transition ${active ? "bg-white text-black shadow-sm" : "hover:bg-[#171717] text-[#ececec] border border-transparent hover:border-[#2f2f2f]"}`}>
                  <span className={`h-7 w-7 grid place-items-center rounded-lg text-[14px] shrink-0 ${active ? "bg-black/10" : "bg-[#212121] border border-[#2f2f2f]"}`}>{n.icon}</span>
                </Link>
              );
            }
            return (
              <Link key={n.href} href={n.href} onClick={()=>setOpen(false)} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${active ? "bg-white text-black shadow-sm" : "hover:bg-[#171717] text-[#ececec]"}`}>
                <span className={`h-7 w-7 grid place-items-center rounded-lg text-[14px] shrink-0 ${active ? "bg-black/10" : "bg-[#212121] border border-[#2f2f2f]"}`}>{n.icon}</span>
                <span className="flex-1 min-w-0">
                  <div className={`leading-none font-medium truncate ${active ? "text-black" : "text-white"}`}>{n.label}</div>
                  <div className={`text-[11px] leading-none mt-1 truncate ${active ? "text-black/60" : "text-[#8e8e8e]"}`}>{n.desc}</div>
                </span>
              </Link>
            );
          })}
          {workspace?.role === "admin" && !collapsed && (
            <Link href="/admin" onClick={()=>setOpen(false)} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${path.startsWith("/admin") ? "bg-white text-black shadow-sm" : "hover:bg-[#171717] text-[#ececec]"}`}>
              <span className="h-7 w-7 grid place-items-center rounded-lg text-[14px] shrink-0 bg-[#212121] border border-[#2f2f2f]">◈</span>
              <span className="flex-1 min-w-0">
                <div className="leading-none font-medium truncate text-white">Admin</div>
                <div className="text-[11px] leading-none mt-1 truncate text-[#8e8e8e]">Members & approvals</div>
              </span>
            </Link>
          )}
        </nav>

        {/* Collections / Tags — hidden when collapsed */}
        {!collapsed ? (
          <div className="flex-1 overflow-auto px-3 pb-3 space-y-4 no-scrollbar">
            <div>
              <div className="flex items-center justify-between px-2 py-2">
                <span className="text-[11px] font-semibold tracking-widest uppercase text-[#8e8e8e]">Collections</span>
                <span className="text-[11px] text-[#5f5f5f]">{collections.length}</span>
              </div>
              <div className="space-y-1">
                {collections.length===0 && <div className="px-2 py-2 text-xs text-[#5f5f5f] italic">No collections yet</div>}
                {collections.map(c=>(
                  <Link key={c.id} href={`/?collection=${c.id}`} onClick={()=>setOpen(false)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[#171717] border border-transparent hover:border-[#2f2f2f]">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{background:c.color}} />
                    <span className="text-sm truncate flex-1 text-[#ececec]">{c.name}</span>
                    <span className="text-xs bg-[#212121] border border-[#2f2f2f] rounded-full px-1.5 py-0.5 text-[#8e8e8e]">{c.document_count}</span>
                  </Link>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between px-2 py-2">
                <span className="text-[11px] font-semibold tracking-widest uppercase text-[#8e8e8e]">Tags</span>
                <span className="text-[11px] text-[#5f5f5f]">{tags.length}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 px-2">
                {tags.length===0 && <span className="text-xs text-[#5f5f5f] italic">No tags</span>}
                {tags.map(t=>(
                  <span key={t.id} className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs bg-[#171717]" style={{borderColor: "#2f2f2f", color: "#ececec"}}>
                    #{t.name} <span className="bg-[#212121] text-[#8e8e8e] rounded-full px-1">{t.document_count}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1" />
        )}

        {!collapsed && (
          <div className="p-3 border-t border-[#2f2f2f] space-y-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
            <div className="rounded-xl bg-[#171717] border border-[#2f2f2f] text-[#ececec] p-3">
              <div className="text-xs font-medium text-white truncate">{user?.email ?? "…"}</div>
              <div className="text-[11px] text-[#8e8e8e] mt-1 leading-relaxed">Shared library • your own inference. Model & keys stay on this device.</div>
              <button onClick={signOut} className="mt-2 rounded-lg bg-[#212121] border border-[#2f2f2f] px-3 py-2 text-xs text-white hover:bg-[#2f2f2f] w-full">Sign out</button>
            </div>
          </div>
        )}
        {collapsed && (
          <div className="p-2 border-t border-[#2f2f2f] flex justify-center">
            <button onClick={()=>setCollapsed(false)} className="h-8 w-8 grid place-items-center rounded-lg bg-[#171717] border border-[#2f2f2f] text-[#8e8e8e] hover:text-white" title="Expand">›</button>
          </div>
        )}
      </aside>
    </>
  );
}
