import {NextResponse} from "next/server";
import {cookies} from "next/headers";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireConnectorOwner,digest,getConnectorAccount} from "@/lib/connectors/registry.server";
import {encryptToken,decryptToken} from "@/lib/connectors/crypto.server";
import {exchangeCode,verifiedGoogleMailbox,GOOGLE_MODIFY_SCOPE,oauthConfig} from "@/lib/connectors/gmail/oauth.server";
export const runtime="nodejs";
const COOKIE="aicafe_gmail_oauth";
const clear=(response:NextResponse)=>{response.cookies.set(COOKIE,"",{path:"/api/connectors/gmail/callback",maxAge:0});return response;};
export async function GET(request:Request){
  const url=new URL(request.url);
  const result=(code:string)=>clear(NextResponse.redirect(url.origin+"/more/gmail?"+(code==="connected"?"connected=1":"error="+code)));
  const state=url.searchParams.get("state"),authCode=url.searchParams.get("code");
  const cookie=(await cookies()).get(COOKIE)?.value;
  if(!state||!authCode||!cookie||cookie!==state||state.length>200||authCode.length>4000)
    return result("authorization_cancelled");
  try{
    if(new URL(oauthConfig().redirectUri).origin!==url.origin)throw new Error("redirect_origin_mismatch");
    const owner=await requireConnectorOwner();
    const db=createAdminSupabaseClient();
    // Single-use CAS consumes even a failed/denied exchange. Cross-owner state is never accepted.
    const {data:row,error:consumeError}=await db.from("connector_oauth_states")
      .update({consumed_at:new Date().toISOString()})
      .eq("state_digest",digest(state)).eq("business_id",owner.businessId)
      .eq("owner_user_id",owner.ownerUserId).is("consumed_at",null)
      .gt("expires_at",new Date().toISOString())
      .select("pkce_verifier_enc").maybeSingle();
    if(consumeError||!row)throw new Error("oauth_state_invalid");
    const tokens=await exchangeCode(authCode,decryptToken(row.pkce_verifier_enc));
    const granted=(tokens.scope??"").split(/\s+/).filter(Boolean);
    if(!granted.includes(GOOGLE_MODIFY_SCOPE)||!tokens.refresh_token)throw new Error("scope_or_refresh_missing");
    const identity=await verifiedGoogleMailbox(tokens.access_token);
    const old=await getConnectorAccount(owner);
    const {data:account,error:accountError}=await db.from("connector_accounts").upsert({
      business_id:owner.businessId,owner_user_id:owner.ownerUserId,provider:"gmail",
      provider_subject:identity.subject,email:identity.email,granted_scopes:granted,
      status:"needs_reconnect",generation:(old?.generation??0)+1,updated_at:new Date().toISOString()
    },{onConflict:"business_id,owner_user_id,provider"}).select("id,generation").single();
    if(accountError||!account)throw new Error("gmail_account_save_failed");
    const credential=await db.from("connector_credentials").upsert({
      account_id:account.id,access_token_enc:encryptToken(tokens.access_token),
      refresh_token_enc:encryptToken(tokens.refresh_token),
      token_expires_at:new Date(Date.now()+tokens.expires_in*1000).toISOString(),
      updated_at:new Date().toISOString()
    },{onConflict:"account_id"});
    if(credential.error)throw new Error("gmail_credentials_save_failed");
    const active=await db.from("connector_accounts").update({status:"active",connected_at:new Date().toISOString(),
      updated_at:new Date().toISOString()}).eq("id",account.id).eq("generation",account.generation)
      .eq("status","needs_reconnect").select("id").maybeSingle();
    if(active.error||!active.data)throw new Error("gmail_connection_changed");
    return result("connected");
  }catch{
    // Never emit provider tokens, Google response bodies or authorization codes.
    return result("connection_failed");
  }
}
