import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {openSourceStream} from "@/lib/externalData/archive.server";

/** Remote IDs belong to the merchant, even when the API filters by location.
 * Keep independent location cursors while sharing one record per merchant ID. */
export function squareArchive(db: SupabaseClient, businessId: string, merchant: string, location: string) {
  if (!merchant || !location) throw new Error("Missing Square source identity");
  return async (resource: string) => {
    const stream = await openSourceStream(db, {businessId, provider: "square", account: merchant}, resource, location);
    return async (rows: readonly unknown[], next: string | null) => {
      const records = rows.map(row => {
        if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string" || !row.id) {
          throw new Error("Missing Square object ID");
        }
        if ("location_id" in row && row.location_id != null && row.location_id !== location) {
          throw new Error("Square returned an object outside the requested location");
        }
        return {key: row.id, payload: row,
          updatedAt: "updated_at" in row && typeof row.updated_at === "string" ? row.updated_at : null};
      });
      await stream.commit(records, next, next === null);
    };
  };
}
