import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {synchronizeSource,type SourceIdentifier} from "@/lib/externalData/archive.server";
import {SquareRequestError,type SquarePageReader} from "./client";
import type {CatalogSourceBinding} from "../types";

/** Remote IDs belong to the merchant, even when the API filters by location.
 * Keep independent location cursors while sharing one record per merchant ID. */
export function squareArchive(db: SupabaseClient, businessId: string, merchant: string, location: string) {
  if (!merchant || !location) throw new Error("Missing Square source identity");
  const source={businessId,provider:"square",account:merchant};
  async function authorize() {
    const {data,error}=await db.from("pos_connections").select("merchant_id,token_expires_at")
      .eq("business_id",businessId).eq("provider","square").eq("merchant_id",merchant)
      .eq("status","active").maybeSingle();
    if(error)throw error;
    if(!data)throw new SquareRequestError(401);
    return data.token_expires_at??data.merchant_id;
  }
  const openCollection=(resource: string, permission: string): SquarePageReader => async (query, fetchPage) => {
    const recordsFrom = (rows: readonly unknown[]) => rows.map(row => {
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
      if(resource==="timecards"&&"team_member_id" in row&&typeof row.team_member_id==="string"&&row.team_member_id){
        identifiers.push({namespace:"team_members",value:row.team_member_id,relationship:"employee",selector:{path:["team_member_id"]}});
      }
      if(resource==="scheduled_shifts"&&"published_shift_details" in row&&
        row.published_shift_details&&typeof row.published_shift_details==="object"){
        const published=row.published_shift_details;
        if("team_member_id" in published&&typeof published.team_member_id==="string"&&published.team_member_id){
          identifiers.push({namespace:"team_members",value:published.team_member_id,relationship:"employee",
            selector:{path:["published_shift_details","team_member_id"]}});
        }
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
    const records = await synchronizeSource(db,source,{
      capability:{resource,permission},stream:location,scope:{location,query:JSON.stringify(query)},
      mode:resource==="catalog"?"snapshot":"window",
      authorize,readCompleted:true,
      observe:async (cursor,scope)=>{
        const savedQuery:unknown=JSON.parse(scope.query);
        if(scope.location!==location||!savedQuery||typeof savedQuery!=="object"||Array.isArray(savedQuery)){
          throw new Error("Invalid Square observation scope");
        }
        const page=await fetchPage(savedQuery as Record<string,unknown>,cursor);
        return {records:recordsFrom(page.items),next:page.next};
      },
      failure:error=>({status:error instanceof SquareRequestError
          ? error.status === 401 || error.status === 403 ? "permission_required" : "unavailable"
          : "incomplete",
        retryAt:error instanceof SquareRequestError ? error.retryAt : undefined,
        resetCursor:error instanceof SquareRequestError && error.status===400}),
    });
    return records as Awaited<ReturnType<typeof fetchPage>>["items"];
  };
  return Object.assign(openCollection,{
    async bindCatalogSources(bindings:CatalogSourceBinding[]) {
      await authorize();
      const {error}=await db.rpc("external_bind_native_identities",{
        p_business:businessId,p_provider:source.provider,p_account:merchant,p_resource:"catalog",
        p_namespace:"pos_item_id",p_native_table:"public.menu_items",p_bindings:bindings,
      });
      if(error)throw error;
    },
  });
}
