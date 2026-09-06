"use client";
import { createContext, useContext, useState, useEffect } from "react";

type Ctx = { open: boolean; setOpen: (v: boolean) => void; collapsed: boolean; setCollapsed: (v: boolean) => void };
const MobileCtx = createContext<Ctx>({ open: false, setOpen: () => {}, collapsed: false, setCollapsed: () => {} });
export const useMobile = () => useContext(MobileCtx);

export default function MobileShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // hydrate collapsed from localStorage (desktop only)
  useEffect(() => {
    try {
      const v = localStorage.getItem("wb_sidebar_collapsed");
      if (v !== null) setCollapsed(v === "1");
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem("wb_sidebar_collapsed", collapsed ? "1" : "0"); } catch {}
  }, [collapsed]);

  return (
    <MobileCtx.Provider value={{ open, setOpen, collapsed, setCollapsed }}>
      {children}
      {/* backdrop for mobile */}
      {open && (
        <button
          aria-label="close sidebar"
          onClick={() => setOpen(false)}
          className="fixed inset-0 bg-black/60 z-30 lg:hidden"
        />
      )}
    </MobileCtx.Provider>
  );
}
