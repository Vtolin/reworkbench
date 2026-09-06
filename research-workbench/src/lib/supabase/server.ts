import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

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
export function createServiceSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("Supabase service credentials are not configured");
  }
  // Lazy import keeps the service key out of the client bundle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createClient } = require("@supabase/supabase-js");
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
