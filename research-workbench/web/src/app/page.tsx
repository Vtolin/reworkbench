import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <p className="text-sm uppercase tracking-widest text-emerald-400">Research Workbench</p>
      <h1 className="mt-4 text-4xl font-semibold text-neutral-100">
        Shared research state. Your own inference.
      </h1>
      <p className="mt-4 text-neutral-400">
        Supabase owns the collaborative library, chats, and research artifacts. Your browser talks to
        your own Ollama (or your own cloud key) for all AI. No member ever touches another member&apos;s
        model.
      </p>
      <div className="mt-8 flex gap-3">
        <Link href="/login" className="rounded bg-neutral-100 px-4 py-2 text-sm font-medium text-black">
          Log in
        </Link>
        <Link href="/register" className="rounded border border-neutral-700 px-4 py-2 text-sm text-neutral-200">
          Register
        </Link>
        <Link href="/dashboard" className="rounded border border-neutral-700 px-4 py-2 text-sm text-neutral-200">
          Dashboard
        </Link>
      </div>
      <ul className="mt-12 space-y-2 text-sm text-neutral-400">
        <li>· Library, research, chats, and projects are workspace-shared (Supabase + RLS).</li>
        <li>· Model, temperature, context length, and API keys stay on your device.</li>
        <li>· Uploads need admin approval before entering the shared library.</li>
      </ul>
    </main>
  );
}
