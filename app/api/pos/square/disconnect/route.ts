import {NextResponse} from "next/server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {decryptToken} from "@/lib/security/tokenCrypto";
import {squareApiBaseUrl} from "@/lib/pos/square/oauth";
export const runtime="nodejs";
/** Explicit owner disconnect revokes Square authorization but keeps historical
 * orders, menu history and attendance. No other café connection is changed. */
export async function POST(request:Request){
 const origin=request.headers.get("origin");
 if(origin!==new URL(request.url).origin)
  return NextResponse.json({error:"invalid_origin"},{status:403});
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 if(!user)return NextResponse.json({error:"unauthorized"},{status:401});
 const businessId=await getActiveBusinessId(user.id);
 const {data:member,error:memberError}=await db.from("memberships")
  .select("role").eq("user_id",user.id).eq("business_id",businessId).maybeSingle();
 if(memberError||member?.role!=="owner")
  return NextResponse.json({error:"unauthorized"},{status:403});
 const {data:connection,error}=await db.from("pos_connections")
  .select("access_token_enc,status").eq("business_id",businessId).eq("provider","square").maybeSingle();
 if(error||!connection)return NextResponse.json({error:"not_connected"},{status:404});
 if(connection.access_token_enc){
  const res=await fetch(squareApiBaseUrl()+"/oauth2/revoke",{
   method:"POST",
   headers:{"content-type":"application/json",
    authorization:"Client "+(process.env.SQUARE_APPLICATION_SECRET??""),
    "Square-Version":"2025-05-21"},
   body:JSON.stringify({client_id:process.env.SQUARE_APPLICATION_ID,
    access_token:decryptToken(connection.access_token_enc)})
  }).catch(()=>null);
  // A failed revoke is not a successful disconnect. The owner can retry safely.
  if(!res?.ok)return NextResponse.json({error:"revoke_failed",retryable:true},{status:503});
 }
 const result=await db.from("pos_connections").update({
  status:"disconnected",access_token_enc:null,refresh_token_enc:null,token_expires_at:null
 }).eq("business_id",businessId).eq("provider","square");
 if(result.error)return NextResponse.json({error:"disconnect_failed"},{status:503});
 return NextResponse.json({disconnected:true,dataPreserved:true});
}
