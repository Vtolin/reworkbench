"use client";

import Link from "next/link";
import { useSession } from "@/contexts/SessionContext";
import { useInference } from "@/contexts/InferenceContext";
import { RealtimeToasts } from "@/components/RealtimeToasts";

const NAV = [
  { href: "/library", title: "Library", desc: "Shared documents, approval queue, collections & tags" },
  { href: "/research", title: "Research", desc: "FTS + pgvector RAG over your own model" },
  { href: "/chats", title: "Chats", desc: "Workspace-visible chats, owner-only continuation, import" },
  { href: "/projects", title: "Projects", desc: "Claims, evidence, citations, research trail" },
  { href: "/admin", title: "Admin", desc: "Members, member limit, kick" },
];

export default function DashboardPage() {
  const { user, workspace, loading } = useSession();
  const { settings, ollamaOnline, ollamaModels } = useInference();

  if (loading) return <main className="p-8 text-sm text-neutral-400">Loading…</main>;
  if (!user) {
    return (
      <main className="mx-auto max-w-md p-8 text-sm text-neutral-300">
        Not signed in. <Link href="/login" className="underline">Log in</Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <RealtimeToasts />
      <p className="text-sm text-neutral-400">{workspace?.name ?? "No workspace"}</p>
      <h1 className="mt-1 text-3xl font-semibold text-neutral-100">Dashboard</h1>
      <p className="mt-2 text-sm text-neutral-400">
        Signed in as {user.email} · role {workspace?.role ?? "—"} · inference{" "}
        <span className="text-neutral-200">
          {settings.provider}:{settings.provider === "ollama" ? settings.model : settings.cloudModel}
        </span>{" "}
        · Ollama {ollamaOnline ? `online (${ollamaModels.length} models)` : "offline"}
      </p>
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className="rounded border border-neutral-800 bg-neutral-950 p-4 hover:border-neutral-600"
          >
            <h2 className="font-medium text-neutral-100">{n.title}</h2>
            <p className="mt-1 text-sm text-neutral-400">{n.desc}</p>
          </Link>
        ))}
      </div>
      <div className="mt-8 rounded border border-neutral-800 p-4 text-sm text-neutral-400">
        <Link href="/reader/demo" className="underline">Open the reader</Link> · Inference settings live in{" "}
        <span className="text-neutral-200">Research → Settings</span> (local/browser state only — never shared).
      </div>
    </main>
  );
}
