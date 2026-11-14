import {NextResponse} from "next/server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {requireConnectorOwner,digest} from "@/lib/connectors/registry.server";
import {encryptToken} from "@/lib/connectors/crypto.server";
import {authorizationUrl,newOAuthChallenge} from "@/lib/connectors/gmail/oauth.server";
export const runtime="nodejs";
const COOKIE="aicafe_gmail_oauth";
export async function GET(request:Request){
  const origin=new URL(request.url).origin;
  try{
    const owner=await requireConnectorOwner();
    const {state,verifier,challenge}=newOAuthChallenge();
    const result=await createAdminSupabaseClient().from("connector_oauth_states").insert({
      state_digest:digest(state),business_id:owner.businessId,owner_user_id:owner.ownerUserId,
      pkce_verifier_enc:encryptToken(verifier),expires_at:new Date(Date.now()+600000).toISOString()
    });
    if(result.error)throw new Error("gmail_oauth_state_unavailable");
    const redirect=NextResponse.redirect(authorizationUrl(state,challenge));
    redirect.cookies.set(COOKIE,state,{httpOnly:true,secure:new URL(request.url).protocol==="https:",
      sameSite:"lax",maxAge:600,path:"/api/connectors/gmail/callback"});
    return redirect;
  }catch(error){
    const code=error instanceof Error&&/owner_required|unauthorized/.test(error.message)?"owner_required":"connection_unavailable";
    return NextResponse.redirect(origin+"/more/gmail?error="+code);
  }
}
