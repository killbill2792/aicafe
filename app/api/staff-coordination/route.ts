import {
 listOwnerStaffCoordination,openOwnerStaffCoordination,decideOwnerStaffCoordination,
 assignOwnerOnboardingChecklist,
 StaffCoordinationError,
} from "@/lib/staffCoordination/cases.server";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store"};
function failure(e:unknown):Response {
 const code=e instanceof StaffCoordinationError?e.code:"storage";
 return Response.json({error:code},{
  status:code==="unauthorized"?403:code==="invalid"?400:code==="conflict"?409:503,
  headers,
 });
}
export async function GET():Promise<Response>{
 try{return Response.json({cases:await listOwnerStaffCoordination()},{headers});}
 catch(e){return failure(e);}
}
/** An explicit owner action, not a model tool. No sensitive fields or provider send. */
export async function POST(request:Request):Promise<Response>{
 if(request.headers.get("origin")!==new URL(request.url).origin)
  return Response.json({error:"invalid_origin"},{status:403,headers});
 if(!request.headers.get("content-type")?.startsWith("application/json"))
  return Response.json({error:"invalid_content_type"},{status:415,headers});
 let payload:unknown;
 try{
  const raw=await request.text();
  if(raw.length>3000)return Response.json({error:"too_large"},{status:413,headers});
  payload=JSON.parse(raw);
 }catch{return Response.json({error:"invalid_json"},{status:400,headers});}
 if(!payload||typeof payload!=="object"||Array.isArray(payload))
  return Response.json({error:"invalid"},{status:400,headers});
 const input=payload as Record<string,unknown>;
 try{
  if(input.action==="open")return Response.json(await openOwnerStaffCoordination({
   nonce:input.nonce,kind:input.kind,employeeId:input.employeeId,
   locationId:input.locationId,from:input.from,to:input.to,role:input.role,
  }),{headers});
  if(input.action==="assign-checklist")return Response.json(await assignOwnerOnboardingChecklist({
   caseId:input.caseId,revision:input.revision,nonce:input.nonce,
   title:input.title,prompt:input.prompt,
  }),{headers});
  if(input.action==="decide")return Response.json(await decideOwnerStaffCoordination({
   caseId:input.caseId,revision:input.revision,choice:input.choice,
  }),{headers});
  return Response.json({error:"invalid"},{status:400,headers});
 }catch(e){return failure(e);}
}
