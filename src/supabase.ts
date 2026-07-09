import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type AuthConfig = {
  supabaseUrl: string;
  supabaseAnonKey: string;
};

let configPromise: Promise<AuthConfig> | null = null;
let clientPromise: Promise<SupabaseClient> | null = null;

async function loadAuthConfig(): Promise<AuthConfig> {
  if (!configPromise) {
    configPromise = fetch("/api/auth/config", { credentials: "same-origin" }).then(async (response) => {
      const payload = (await response.json().catch(() => ({}))) as Partial<AuthConfig> & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Supabase Auth is not configured.");
      if (!payload.supabaseUrl || !payload.supabaseAnonKey) throw new Error("Supabase Auth is not configured.");
      return {
        supabaseUrl: payload.supabaseUrl,
        supabaseAnonKey: payload.supabaseAnonKey,
      };
    });
  }
  return configPromise;
}

export async function getSupabaseClient(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = loadAuthConfig().then((config) =>
      createClient(config.supabaseUrl, config.supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }),
    );
  }
  return clientPromise;
}

export async function getAccessToken(): Promise<string | null> {
  const supabase = await getSupabaseClient();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function signInWithGoogle(): Promise<void> {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/app`,
    },
  });
  if (error) throw error;
}

export async function signOutOfSupabase(): Promise<void> {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
