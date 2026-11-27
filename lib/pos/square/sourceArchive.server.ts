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
        let identifiers: {namespace: string; value: string; selector: object}[] | undefined;
        if (resource === "catalog" && "item_data" in row && row.item_data && typeof row.item_data === "object") {
          const data=row.item_data;
          if ("variations" in data && Array.isArray(data.variations)) {
            identifiers=data.variations.flatMap(v => typeof v?.id === "string"
              ? [{namespace:"pos_item_id",value:v.id,selector:{path:["item_data"],variation:v.id}}] : []);
          }
        }
        return {key: row.id, payload: row, identifiers,
          updatedAt: "updated_at" in row && typeof row.updated_at === "string" ? row.updated_at : null};
      });
      await stream.commit(records, next, next === null);
    };
  };
}
