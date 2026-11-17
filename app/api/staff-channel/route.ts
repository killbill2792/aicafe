import {submitStaffReply,getStaffInbox,StaffChannelError} from "@/lib/staffCommunication/channel.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store"};
export async function GET():Promise<Response>{
 try{return Response.json(await getStaffInbox(),{headers});}
 catch(e){return Response.json({error:e instanceof StaffChannelError?e.code:"unavailable"},
  {status:e instanceof StaffChannelError&&["unauthorized","not_linked"].includes(e.code)?403:503,headers});}
}
export async function POST(request:Request):Promise<Response>{
 const origin=request.headers.get("origin");
 if(origin!==new URL(request.url).origin)return Response.json({error:"invalid_origin"},{status:403,headers});
 if(!request.headers.get("content-type")?.startsWith("application/json"))
  return Response.json({error:"invalid_content_type"},{status:415,headers});
 let input:unknown;
 try{
  const raw=await request.text();
  if(raw.length>5000)return Response.json({error:"too_large"},{status:413,headers});
  input=JSON.parse(raw);
 }catch{return Response.json({error:"invalid_json"},{status:400,headers});}
 try{
  return Response.json(await submitStaffReply(input),{headers});
 }catch(e){
  const code=e instanceof StaffChannelError?e.code:"storage";
  const status=code==="unauthorized"||code==="not_linked"?403:code==="invalid"?400:code==="conflict"||code==="stale_request"?409:503;
  return Response.json({error:code},{status,headers});
 }
}
