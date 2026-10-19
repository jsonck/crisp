import { createClient } from "@supabase/supabase-js";

// Signing in with a magic link every time you reload the KB editor is a bad
// local loop, so `npm run dev` skips it — but it skips the *typing*, not the
// session. With VITE_SUPABASE_DEV_KEY set we use that service_role key once, via
// the admin API, to mint a genuine magic-link token for VITE_DEV_EDITOR_EMAIL
// and redeem it. From then on the app holds a real editor JWT.
//
// Doing it this way rather than running every query as service_role matters:
//   - RLS stays ON locally, so you are testing the policies you ship.
//   - is_kb_editor() answers truthfully, so the editor's own gate is exercised.
//   - The API's /answer endpoint re-checks the token server-side. A real JWT
//     passes that; service_role has no JWT and would 403.
//
// `import.meta.env.DEV` is statically false in a production build, so Rollup
// drops this whole branch and the key cannot reach the bundle. Keep it out of
// Netlify regardless.
export const DEV_NO_LOGIN =
  import.meta.env.DEV && Boolean(import.meta.env.VITE_SUPABASE_DEV_KEY);

const DEV_EDITOR_EMAIL = import.meta.env.VITE_DEV_EDITOR_EMAIL as string | undefined;

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY
);

// Resolves once the local session exists, so callers can await it instead of
// racing it. A no-op (and a resolved promise) in any real deployment.
export const devSignIn: Promise<void> = DEV_NO_LOGIN
  ? establishDevSession()
  : Promise.resolve();

async function establishDevSession() {
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session) return;

    if (!DEV_EDITOR_EMAIL) {
      console.warn(
        "[dev] VITE_SUPABASE_DEV_KEY is set but VITE_DEV_EDITOR_EMAIL is not — " +
          "cannot mint a local session. Falling back to the normal login."
      );
      return;
    }

    // Admin-only call, hence a throwaway client on the service key. It is used
    // for exactly this one request and never for app queries.
    const admin = createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_DEV_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const { data: link, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: DEV_EDITOR_EMAIL,
    });

    if (linkError || !link?.properties?.hashed_token) {
      console.error("[dev] could not generate a local sign-in token:", linkError);
      return;
    }

    const { error: verifyError } = await supabase.auth.verifyOtp({
      type: "magiclink",
      token_hash: link.properties.hashed_token,
    });

    if (verifyError) {
      console.error("[dev] could not redeem the local sign-in token:", verifyError);
      return;
    }

    console.info(`[dev] signed in as ${DEV_EDITOR_EMAIL} — no login page needed.`);
  } catch (e) {
    console.error("[dev] local sign-in failed:", e);
  }
}

export interface Snapshot {
  id?: string;
  session_id: string;
  nickname: string;
  email: string;
  analysis: any;
  messages: any[];
  created_at?: string;
}

export async function publishSnapshot(snapshot: Omit<Snapshot, "id" | "created_at">) {
  const { data, error } = await supabase
    .from("snapshots")
    .insert(snapshot)
    .select("id")
    .single();

  if (error) {
    console.error("Supabase insert error:", error);
    return null;
  }

  return data.id as string;
}

export async function getSnapshot(id: string): Promise<Snapshot | null> {
  const { data, error } = await supabase
    .from("snapshots")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error("Supabase fetch error:", error);
    return null;
  }

  return data as Snapshot;
}
