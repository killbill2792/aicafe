import {readOwnerStaffHistory,StaffChannelError} from "@/lib/staffCommunication/channel.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store"};
/** Owner-only, source-scoped read of the existing staff communication ledger. */
export async function GET(request:Request):Promise<Response>{
 const search=new URL(request.url).searchParams;
 if([...search.keys()].some(k=>k!=="at"&&k!=="id")||
  (search.has("at")!==search.has("id"))||
  (search.getAll("at").length>1||search.getAll("id").length>1))
  return Response.json({error:"invalid"},{status:400,headers});
 const cursor=search.has("at")?{at:search.get("at"),id:search.get("id")}:null;
 try{return Response.json(await readOwnerStaffHistory(cursor),{headers});}
 catch(e){
  const code=e instanceof StaffChannelError?e.code:"storage";
  return Response.json({error:code},{status:code==="unauthorized"?403:
   code==="invalid"?400:503,headers});
 }
}
