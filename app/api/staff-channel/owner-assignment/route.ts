import {assignOwnerStaffWork,StaffChannelError} from "@/lib/staffCommunication/channel.server";
import {requireSameOrigin} from "@/lib/ai/conversations/http.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store"};
/** Manual owner-only assignment. Other autonomous PRs must use their own
 * approved effect gateway; this endpoint cannot be called with a model role. */
export async function POST(request:Request):Promise<Response>{
 // Match the actual authenticated browser Host even if Next.js normalizes
 // the internal Request.url. A missing or forged Origin still fails closed.
 try{requireSameOrigin(request)}catch{
  return Response.json({error:"invalid_origin"},{status:403,headers});
 }
 if(!request.headers.get("content-type")?.startsWith("application/json"))
  return Response.json({error:"invalid_type"},{status:415,headers});
 let raw:unknown;
 try{
  const text=await request.text();
  if(text.length>5200)return Response.json({error:"too_large"},{status:413,headers});
  raw=JSON.parse(text);
 }catch{return Response.json({error:"invalid_json"},{status:400,headers});}
 try{return Response.json(await assignOwnerStaffWork(raw),{headers});}
 catch(e){
  const code=e instanceof StaffChannelError?e.code:"storage";
  return Response.json({error:code},
   {status:code==="unauthorized"||code==="not_linked"?403:code==="invalid"?400:code==="conflict"||code==="stale_request"?409:503,headers});
 }
}
