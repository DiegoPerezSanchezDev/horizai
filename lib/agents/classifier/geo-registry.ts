import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../types/database.ts";
import { createSupabaseServerClient } from "../../supabase/server-client.ts";

export type RegionReference = { code: string; name: string; latitude: number | null; longitude: number | null };
export type CategoryReference = { slug: string; name: string };
export type ReferenceRegistry = { regions: ReadonlyMap<string, RegionReference>; categories: ReadonlyMap<string, CategoryReference> };

export function createReferenceRegistry(regions: RegionReference[], categories: CategoryReference[]): ReferenceRegistry {
  return {
    regions: new Map(regions.map((region) => [region.code, region])),
    categories: new Map(categories.map((category) => [category.slug, category])),
  };
}

export async function loadActiveReferenceRegistry(supabase: SupabaseClient<Database> = createSupabaseServerClient()): Promise<ReferenceRegistry> {
  const [regionsResponse, categoriesResponse] = await Promise.all([
    supabase.from("regions").select("code,name,latitude,longitude").eq("is_active", true),
    supabase.from("categories").select("slug,name").eq("is_active", true),
  ]);
  if (regionsResponse.error) throw new Error(`read active regions for classifier: ${regionsResponse.error.message}`);
  if (categoriesResponse.error) throw new Error(`read active categories for classifier: ${categoriesResponse.error.message}`);
  return createReferenceRegistry(regionsResponse.data ?? [], categoriesResponse.data ?? []);
}
