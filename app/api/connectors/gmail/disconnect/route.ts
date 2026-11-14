import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireConnectorOwner,getConnectorAccount} from "@/lib/connectors/registry.server";
import {decryptToken} from "@/lib/connectors/crypto.server";
export const runtime="nodejs";
export async function POST(request:Request){
  if(request.headers.get("origin")!==new URL(request.url).origin)
    return NextResponse.json({error:"invalid_origin"},{status:403});
  let owner;
  try{owner=await requireConnectorOwner();}catch{
    return NextResponse.json({error:"owner_required"},{status:403});
  }
  const db=createAdminSupabaseClient();
  const account=await getConnectorAccount(owner);
  if(!account||account.status==="disconnected")return NextResponse.json({status:"disconnected"});
  // Local revocation FIRST. No Gmail action is authorized once status changes.
  if(account.status!=="revoking"){
    const {data,error}=await db.from("connector_accounts").update({
      status:"revoking",generation:account.generation+1,updated_at:new Date().toISOString()
    }).eq("id",account.id).eq("generation",account.generation).select("id").maybeSingle();
    if(error||!data)return NextResponse.json({error:"connection_changed"},{status:409});
  }
  const {data:secret,error:secretError}=await db.from("connector_credentials")
    .select("refresh_token_enc").eq("account_id",account.id).maybeSingle();
  if(secretError)return NextResponse.json({status:"revoking",error:"revoke_pending"},{status:503});
  if(secret){
    try{
      const token=decryptToken(secret.refresh_token_enc);
      const response=await fetch("https://oauth2.googleapis.com/revoke",{
        method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams({token}),cache:"no-store",signal:AbortSignal.timeout(12000)});
      if(!response.ok)return NextResponse.json({status:"revoking",error:"revoke_pending"},{status:503});
    }catch{return NextResponse.json({status:"revoking",error:"revoke_pending"},{status:503});}
    const removed=await db.from("connector_credentials").delete().eq("account_id",account.id);
    if(removed.error)return NextResponse.json({status:"revoking",error:"revoke_pending"},{status:503});
  }
  const saved=await db.from("connector_accounts").update({status:"disconnected",updated_at:new Date().toISOString()})
    .eq("id",account.id).eq("status","revoking");
  if(saved.error)return NextResponse.json({status:"revoking",error:"revoke_pending"},{status:503});
  return NextResponse.json({status:"disconnected",dataPreserved:true});
}
