import {NextResponse} from "next/server";
import {requireConnectorOwner,getConnectorAccount,allowsGmail} from "@/lib/connectors/registry.server";
import {oauthConfig} from "@/lib/connectors/gmail/oauth.server";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(){
  try{
    const owner=await requireConnectorOwner();
    const account=await getConnectorAccount(owner);
    let configured=true;
    try{oauthConfig();}catch{configured=false;}
    const status=account?.status??"disconnected";
    return NextResponse.json({status,configured,email:account?.email??null,
      permissions:{read:allowsGmail(account,"read"),draft:allowsGmail(account,"draft"),
        send:allowsGmail(account,"send"),organize:allowsGmail(account,"organize")}},
      {headers:{"cache-control":"no-store"}});
  }catch{
    return NextResponse.json({error:"owner_required"},{status:403,headers:{"cache-control":"no-store"}});
  }
}
