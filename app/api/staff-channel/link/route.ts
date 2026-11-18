import {ownerStaffLoginList,ownerLinkExistingLogin,StaffChannelError} from "@/lib/staffCommunication/channel.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store"};
export async function GET():Promise<Response>{
 try{return Response.json({employees:await ownerStaffLoginList()},{headers});}
 catch(e){return Response.json({error:e instanceof StaffChannelError?e.code:"storage"},
  {status:e instanceof StaffChannelError&&e.code==="unauthorized"?403:503,headers});}
}
export async function POST(request:Request):Promise<Response>{
 if(request.headers.get("origin")!==new URL(request.url).origin)
  return Response.json({error:"invalid_origin"},{status:403,headers});
 if(!request.headers.get("content-type")?.startsWith("application/json"))
  return Response.json({error:"invalid_type"},{status:415,headers});
 let input:unknown;
 try{
  const raw=await request.text();
  if(raw.length>2000)return Response.json({error:"too_large"},{status:413,headers});
  input=JSON.parse(raw);
 }catch{return Response.json({error:"invalid_json"},{status:400,headers});}
 try{return Response.json(await ownerLinkExistingLogin(input),{headers});}
 catch(e){const code=e instanceof StaffChannelError?e.code:"storage";
  return Response.json({error:code},{status:code==="unauthorized"?403:code==="conflict"?409:code==="invalid"?400:503,headers});}
}
