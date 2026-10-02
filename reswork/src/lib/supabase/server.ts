import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

// Server-side (RLS-aware) client: forwards the user's session cookies so
// RLS policies see auth.uid(). Use for all user-scoped server actions.
export async function createServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet: Array<{ name: string; value: string; options?: object }>) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Called from a Server Component — cookies are read-only there.
          }
        },
      },
    },
  );
}

// Service-role client: bypasses RLS. ONLY for bootstrap/admin operations
// that RLS cannot express (register-admin workspace creation, session
// invalidation on kick). Never expose to the browser.
//
// Module-cached (Phase 5): the service client carries no per-request state
// (no cookies, no session refresh), so one instance is reused across
// requests instead of rebuilding the client per call. The RLS-aware
// createServerSupabase above intentionally stays per-request — it forwards
// the caller's session cookies and must not be shared.
let cachedServiceClient: SupabaseClient | null = null;
export function createServiceSupabase(): SupabaseClient {
  const cached: SupabaseClient | null = cachedServiceClient;
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Supabase service credentials are not configured");
  }
  // Lazy import keeps the service key out of the client bundle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@supabase/supabase-js");
  const fresh: SupabaseClient = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  cachedServiceClient = fresh;
  return fresh;
}
