import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../types/database";

function requiredServerEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "SUPABASE_SECRET_KEY") {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required server environment variable: ${name}`);
  }

  return value;
}

/** Node/server helper for trusted CLI and backend modules; never import from client code. */
export function createSupabaseServerClient(options: { privateNoStore?: boolean } = {}): SupabaseClient<Database> {
  const url = requiredServerEnv("NEXT_PUBLIC_SUPABASE_URL");
  const secretKey = requiredServerEnv("SUPABASE_SECRET_KEY");

  return createClient<Database>(url, secretKey, {
    ...(options.privateNoStore ? { global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }) } } : {}),
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
