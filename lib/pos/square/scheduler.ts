import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {decryptToken,encryptToken} from "@/lib/security/tokenCrypto";
import {refreshAccessToken} from "./oauth";
import {createSquareAdapter} from "./adapter";
import {syncPosData} from "../sync";
import {fromZonedTime,formatInTimeZone} from "date-fns-tz";
type Tick={checked:number;synced:number;reconnect:number;failed:number};
/** Square fetches new days plus three café-local prior days so late fees and
 * refunds become actual, without replaying every 90-day backfill each tick. */
export async function syncSquareTick(db:SupabaseClient,now=new Date()):Promise<Tick>{
 const result:Tick={checked:0,synced:0,reconnect:0,failed:0};
 const {data:connections,error}=await db.from("pos_connections")
  .select("business_id,merchant_id,access_token_enc,refresh_token_enc,token_expires_at,last_synced_at")
  // Oldest/sync-never locations run first. A static business-id order would
  // permanently starve every café after the first 100 connections.
  .eq("provider","square").eq("status","active")
  .order("last_synced_at",{ascending:true,nullsFirst:true})
  .order("business_id").limit(100);
 if(error)throw error;
 for(const conn of connections??[]){
  result.checked++;
  const {data:claimed,error:claimError}=await db.rpc("square_claim_sync_lease",{
    p_business_id:conn.business_id,p_seconds:300
  });
  if(claimError){result.failed++;continue;}
  if(!claimed)continue;
  try{
   const {data:business,error:businessError}=await db.from("businesses")
    .select("timezone").eq("id",conn.business_id).single();
   if(businessError||!business)throw new Error("Square café timezone unavailable");
   const {data:locations,error:locationError}=await db.from("locations")
    .select("id,pos_location_id").eq("business_id",conn.business_id)
    .not("pos_location_id","is",null).order("id").limit(10);
   if(locationError||!locations?.length)throw new Error("Square location missing");
   let token=decryptToken(conn.access_token_enc);
   const renew=!conn.token_expires_at||
    Date.parse(conn.token_expires_at)<now.getTime()+24*60*60*1000;
   if(renew){
    if(!conn.refresh_token_enc)throw new Error("Square authentication unavailable");
    const updated=await refreshAccessToken(decryptToken(conn.refresh_token_enc));
    token=updated.access_token;
    const {error:updateError}=await db.from("pos_connections").update({
     access_token_enc:encryptToken(token),
     refresh_token_enc:encryptToken(updated.refresh_token),
     token_expires_at:updated.expires_at
    }).eq("business_id",conn.business_id).eq("provider","square").eq("status","active");
    if(updateError)throw updateError;
   }
   const last=conn.last_synced_at?new Date(conn.last_synced_at):new Date(now.getTime()-90*86400000);
   const first=new Date(Math.min(last.getTime()-3*86400000,now.getTime()-86400000));
   const cafeDay=formatInTimeZone(now,business.timezone,"yyyy-MM-dd");
   const from=fromZonedTime(cafeDay+"T00:00:00",business.timezone);
   const since=first<from?first:from;
   for(const location of locations){
    await syncPosData(db,{businessId:conn.business_id,locationId:location.id,
     timezone:business.timezone,adapter:createSquareAdapter({
      accessToken:token,locationId:location.pos_location_id}),since,until:now});
   }
   const {error:doneError}=await db.from("pos_connections").update({
    last_synced_at:now.toISOString(),status:"active"
   }).eq("business_id",conn.business_id).eq("provider","square");
   if(doneError)throw doneError;
   result.synced++;
  }catch(error){
   const message=error instanceof Error?error.message:"";
   const auth=/Square (?:API error|token refresh failed) \(?401|Square (?:API error|token refresh failed) \(?403|authentication unavailable/i.test(message);
   if(auth){
    const {error:reconnectError}=await db.from("pos_connections").update({
      status:"needs_reconnect"
    }).eq("business_id",conn.business_id).eq("provider","square");
    if(reconnectError)result.failed++;
    else result.reconnect++;
   }else result.failed++;
  }finally{
   // Do not clear a newer worker's lease; letting it expire is safer than an
   // unguarded release, and the next tick can retry after five minutes.
  }
 }
 return result;
}
