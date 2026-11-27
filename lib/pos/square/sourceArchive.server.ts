import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {discoverSourceResources,noteAvailability,openSourceStream,type SourceIdentifier} from "@/lib/externalData/archive.server";
import {SquareRequestError} from "./client";

/** Remote IDs belong to the merchant, even when the API filters by location.
 * Keep independent location cursors while sharing one record per merchant ID. */
export function squareArchive(db: SupabaseClient, businessId: string, merchant: string, location: string) {
  if (!merchant || !location) throw new Error("Missing Square source identity");
  const source={businessId,provider:"square",account:merchant};
  return async (resource: string, permission: string) => {
    await discoverSourceResources(db,source,[{resource,permission}],new Date().toISOString());
    const stream = await openSourceStream(db,source,resource,location);
    const save = async (rows: readonly unknown[], next: string | null) => {
      const records = rows.map(row => {
        if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string" || !row.id) {
          throw new Error("Missing Square object ID");
        }
        if ("location_id" in row && row.location_id != null && row.location_id !== location) {
          throw new Error("Square returned an object outside the requested location");
        }
        const identifiers: SourceIdentifier[]=[{namespace:resource,value:row.id,selector:{path:[]}}];
        if (resource === "payments" && "order_id" in row && typeof row.order_id === "string" && row.order_id) {
          identifiers.push({namespace:"orders",value:row.order_id,relationship:"payment_for",selector:{path:[]}});
        }
        if (resource === "catalog" && "item_data" in row && row.item_data && typeof row.item_data === "object") {
          const data=row.item_data;
          let variants: SourceIdentifier[]=[];
          if ("variations" in data && Array.isArray(data.variations)) {
            variants=data.variations.flatMap(v => typeof v?.id === "string"
              ? [{namespace:"pos_item_id",value:v.id,selector:{path:["item_data"],variation:v.id}}] : []);
          }
          identifiers.push(...(variants.length ? variants :
            [{namespace:"pos_item_id",value:row.id,selector:{path:["item_data"]}}]));
        }
        return {key: row.id, payload: row, identifiers,
          updatedAt: "updated_at" in row && typeof row.updated_at === "string" ? row.updated_at : null};
      });
      await stream.commit(records, next, next === null);
    };
    return Object.assign(save,{
      failed: (error: unknown) => noteAvailability(db,source,resource,
        error instanceof SquareRequestError
          ? error.status === 401 || error.status === 403 ? "permission_required" : "unavailable"
          : "incomplete",
        new Date().toISOString(),error instanceof SquareRequestError ? error.retryAt : undefined),
    });
  };
}
