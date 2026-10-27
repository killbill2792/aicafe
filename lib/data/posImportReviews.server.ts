import "server-only";
import {staffReadScope} from "@/lib/scheduling/staffScope.server";

export type PosStaffImportReview={
 reviewType:"staff_identity"|"unlinked_timecard"|"overlapping_timecard"|"shift_corrected";
 sourceKey:string;
 detail:Record<string,unknown>;
};
const kinds=["staff_identity","unlinked_timecard","overlapping_timecard","shift_corrected"];
/** The active authenticated café only. Never expose another tenant's staff. */
export async function getOpenPosStaffImportReviews():Promise<{
 available:boolean;reviews:PosStaffImportReview[];truncated:boolean
}>{
 const scope=await staffReadScope();
 if(!scope.ok||!scope.supabase)return {available:false,reviews:[],truncated:false};
 const {data,error}=await scope.supabase.from("pos_import_reviews")
  .select("review_type,source_key,detail")
  .eq("business_id",scope.businessId).eq("provider","toast")
  .eq("status","needs_owner")
  .in("review_type",kinds)
  .order("created_at",{ascending:false}).limit(101);
 if(error){
  // Old installations stay usable until the owner applies migration 101.
  if(["42P01","PGRST205"].includes(error.code??""))
   return {available:false,reviews:[],truncated:false};
  throw error;
 }
 return {available:true,truncated:(data??[]).length>100,
  reviews:(data??[]).slice(0,100).map(row=>({
   reviewType:row.review_type as PosStaffImportReview["reviewType"],
   sourceKey:row.source_key,
   detail:row.detail&&typeof row.detail==="object"&&!Array.isArray(row.detail)?
    row.detail as Record<string,unknown>:{}
  }))};
}
