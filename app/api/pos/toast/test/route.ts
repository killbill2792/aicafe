import {copyToastPublishedMenu,copyToastStaff,copyToastAttendance,recordToastCopyFailure} from "@/lib/pos/toast/operationalCopy";
import {refreshToastRestaurantInfo} from "@/lib/pos/toast/restaurantInfo";
import {verificationFailure} from "@/lib/pos/toast/verificationState";
import {NextResponse} from "next/server";
import {z} from "zod";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {createToastClient,GUID,ToastApiError,toToastTimestamp} from "@/lib/pos/toast/client";
export const runtime="nodejs";
// Credential verification and first catalog copy share one bounded request.
export const maxDuration=300;
export const dynamic="force-dynamic";
const json=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
const expected=z.object({businessId:GUID}).strict();
export async function POST(request:Request){
  if(process.env.TOAST_SETUP_ENABLED!=="true")return json(503,{error:"setup_disabled"});
  const body=expected.safeParse(await request.json().catch(()=>null));
  if(!body.success)return json(400,{error:"invalid_request"});
  const businessId=body.data.businessId;
  const db=await authorizeToastOwner(businessId);
  if(!db)return json(403,{error:"not_authorized"});
  const {data:mappings,error}=await db.from("toast_location_mappings")
    .select("restaurant_guid,verified_at,location_id,toast_time_zone").eq("business_id",businessId);
  if(error||!mappings?.length)return json(400,{error:"no_locations"});
  const {data:current,error:credentialError}=await db.from("toast_api_credentials")
    .select("state").eq("business_id",businessId).maybeSingle();
  if(credentialError)return json(503,{error:"credential_read_failed"});
  const previouslyVerified=current?.state==="verified"&&mappings.every(l=>l.verified_at);
  const client=createToastClient(db,businessId);
  const start=toToastTimestamp(new Date(Date.now()-60000));
  const end=toToastTimestamp(new Date());
  const query=(p:string)=>p+"?startDate="+start+"&endDate="+end;
  const scopesAvailable:{menus:boolean;labor:boolean;config:boolean}={menus:true,labor:true,config:true};
  try {
    for(const mapping of mappings) {
      const guid=mapping.restaurant_guid;
      await refreshToastRestaurantInfo(db,businessId,guid,{allowUnverified:true});
      // Standard access needs only orders and restaurant identity. Optional
      // scopes are probed independently; a 403 must not disconnect sales.
      await client.request(query("/orders/v2/ordersBulk")+"&pageSize=1&page=1",guid,z.array(z.unknown()),{allowUnverified:true});
      for(const [scope,path] of [
        ["menus","/menus/v2/metadata"],["labor","/labor/v1/employees"],
        ["config","/config/v2/voidReasons"]
      ] as const){
        try {
          await client.request(path,guid,z.unknown(),{allowUnverified:true});
        }catch(err) {
          if(err instanceof ToastApiError&&["missing_scope_or_location","missing_permissions"].includes(err.category))
            scopesAvailable[scope]=false;
          else throw err;
        }
      }

    }
    const at=new Date().toISOString();
    for(const mapping of mappings) {
      const {error:save}=await db.from("toast_location_mappings")
        .update({verified_at:at}).eq("business_id",businessId).eq("restaurant_guid",mapping.restaurant_guid);
      if(save)throw new ToastApiError("unavailable");
    }
    const {error:updated}=await db.from("toast_api_credentials").update({
      state:"verified",last_verified_at:at,last_error_category:null,scopes_available:scopesAvailable
    }).eq("business_id",businessId);
    if(updated)throw new ToastApiError("unavailable");
    // Once verification is durable, copy the published menu BEFORE queueing sales.
    // The menu or labor scope may be absent; each failed optional source is isolated.
    let menuPending=false,laborPending=false;
    for(const mapping of mappings){
      // The cron importer uses this same verified-location lease. Do not race
      // its alias matching, roster linking or price-history updates.
      const {data:nonce,error:leaseError}=await db.rpc("toast_acquire_lease",{
        p_business_id:businessId,p_restaurant_guid:mapping.restaurant_guid,p_seconds:290
      });
      if(leaseError||!nonce){
        menuPending ||= scopesAvailable.menus;
        laborPending ||= scopesAvailable.labor;
        continue; // Verification remains successful; cron owns the next sync.
      }
      try{
      const scope={businessId,restaurantGuid:mapping.restaurant_guid,
        locationId:mapping.location_id,timezone:mapping.toast_time_zone||"America/Los_Angeles"};
      if(scopesAvailable.menus){
        try{await copyToastPublishedMenu(db,scope);}
        catch(copyError){
          menuPending=true;
          try{await recordToastCopyFailure(db,scope,"menu",copyError);}
          catch{menuPending=true;}
        }
      }
      if(scopesAvailable.labor){
        try{await copyToastStaff(db,scope);}
        catch(copyError){
          laborPending=true;
          try{await recordToastCopyFailure(db,scope,"roster",copyError);}
          catch{laborPending=true;}
        }
        try{
          const end=new Date();
          await copyToastAttendance(db,scope,{
            since:new Date(end.getTime()-7*86400000),until:end
          });
        }catch(copyError){
          laborPending=true;
          try{await recordToastCopyFailure(db,scope,"labor",copyError);}
          catch{laborPending=true;}
        }
      }
      }finally{
        const {error:releaseError}=await db.rpc("toast_release_lease",{p_nonce:nonce});
        if(releaseError){
          // Do not unverify the already-verified café for a secondary failure.
          menuPending ||= scopesAvailable.menus;
          laborPending ||= scopesAvailable.labor;
        }
      }
    }
    // Credential verification succeeded and is now durable. A separate queue
    // failure must NEVER revert its status or revoke a newly verified location.
    let recoveryPending=false;
    for(const mapping of mappings){
      try{
        const {error:retryError}=await db.rpc("toast_requeue_failed",{
          p_business_id:businessId,p_restaurant_guid:mapping.restaurant_guid});
        if(retryError)recoveryPending=true;
      }catch{recoveryPending=true;}
    }
    return json(200,{state:"verified",locationsVerified:mappings.length,
      scopesAvailable,recoveryPending,menuPending,laborPending});
  } catch(err){
    const category=err instanceof ToastApiError?err.category:"unavailable";
    const outcome=verificationFailure(Boolean(previouslyVerified),category);
    if(!outcome.preserveVerification)
      await db.from("toast_location_mappings").update({verified_at:null}).eq("business_id",businessId);
    await db.from("toast_api_credentials").update({
      state:outcome.state,last_error_category:category,
      ...(!outcome.preserveVerification?{last_verified_at:null}:{}),
    }).eq("business_id",businessId);
    return json(category==="rate_limited"?429:422,{
      state:outcome.state,verified:outcome.preserveVerification&&Boolean(previouslyVerified),
      error:category,retryAfter:err instanceof ToastApiError?err.retryAt:undefined});
  }
}
