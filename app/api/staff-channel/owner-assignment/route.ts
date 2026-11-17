import {assignOwnerStaffWork,StaffChannelError} from "@/lib/staffCommunication/channel.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store"};
/** Manual owner-only assignment. Other autonomous PRs must use their own
 * approved effect gateway; this endpoint cannot be called with a model role. */
export async function POST(request:Request):Promise<Response>{
 if(request.headers.get("origin")!==new URL(request.url).origin)
  return Response.json({error:"invalid_origin"},{status:403,headers});
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
   {status:code==="unauthorized"||code==="not_linked"?403:code==="invalid"?400:code==="conflict"?409:503,headers});
 }
}
