import {MAX_WEBHOOK_BYTES,parseWebhook,verifyChallenge,verifySignature} from "@/lib/whatsapp/webhook";
import {TEST_PHONE_NUMBER_ID} from "@/lib/whatsapp/transport";
import {acceptSignedMessage} from "@/lib/whatsapp/identity.server";
import {recordSignedStatus} from "@/lib/whatsapp/queue.server";
import {recordSignedStaffScheduleStatus} from "@/lib/scheduling/staffPublication.server";
export const runtime="nodejs";
export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store"};
function answer(status:number,body:string):Response {
  return new Response(body,{status,headers:{...headers,"Content-Type":"text/plain; charset=utf-8"}});
}
export async function GET(request:Request):Promise<Response>{
  const challenge=verifyChallenge(new URL(request.url).searchParams,process.env.WHATSAPP_VERIFY_TOKEN);
  return challenge===null?answer(403,"Forbidden"):answer(200,challenge);
}
async function boundedBody(request:Request):Promise<Buffer>{
  const claimed=Number(request.headers.get("content-length"));
  if(claimed>MAX_WEBHOOK_BYTES)throw new Error("invalid_size");
  if(!request.body)return Buffer.alloc(0);
  const reader=request.body.getReader(),parts:Buffer[]=[];
  let total=0;
  try {
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>MAX_WEBHOOK_BYTES)throw new Error("invalid_size");
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts,total);
  }finally{reader.releaseLock();}
}
/** Signed batched events are committed to Postgres before a 200. No model call
 * or provider reply runs in the webhook request. Meta retries on DB failure. */
export async function POST(request:Request):Promise<Response>{
  let bytes:Buffer;
  try{bytes=await boundedBody(request);}
  catch{return answer(413,"Payload too large");}
  if(!verifySignature(bytes,request.headers.get("x-hub-signature-256"),
    process.env.WHATSAPP_APP_SECRET))return answer(401,"Unauthorized");
  let events:ReturnType<typeof parseWebhook>;
  try {
    const ownerPhoneId=process.env.WHATSAPP_PHONE_NUMBER_ID??TEST_PHONE_NUMBER_ID;
    // Preserve the original owner-only webhook boundary: it is wired to the
    // Meta developer test sender, NEVER to a production employee sender.
    if(ownerPhoneId!==TEST_PHONE_NUMBER_ID)return answer(503,"Not configured");
    const staffPhoneId=process.env.WHATSAPP_STAFF_PHONE_NUMBER_ID??"";
    const staffEnabled=process.env.WHATSAPP_STAFF_SCHEDULE_SEND_ENABLED==="true"&&
      process.env.WHATSAPP_STAFF_SENDER_APPROVED==="true"&&
      /^[0-9]{8,25}$/.test(staffPhoneId)&&staffPhoneId!==ownerPhoneId;
    events=parseWebhook(bytes,staffEnabled?[ownerPhoneId,staffPhoneId]:ownerPhoneId);
    // Worker inbound messages are not owner commands (Task 13C separately).
    // They must not prevent independent signed status receipts in the same
    // Meta batch from being persisted; acknowledge without dispatching AI.
  }catch(error){
    return answer(error instanceof Error&&error.message==="wrong_sender"?403:422,"Invalid event");
  }
  try{
    for(const event of events){
      if(event.type==="message"){
        if(event.phoneId===(process.env.WHATSAPP_PHONE_NUMBER_ID??TEST_PHONE_NUMBER_ID))
          await acceptSignedMessage(event);
        // Employee messages require Task13C authorization and must never be
        // dispatched as owner commands or suppress other signed status events.
      }else if(event.phoneId===(process.env.WHATSAPP_PHONE_NUMBER_ID??TEST_PHONE_NUMBER_ID)){
        await recordSignedStatus(event);
      }else{
        // Codex P1: the common signed status ledger must persist BEFORE
        // staff-specific projection, because the callback can precede Meta's
        // HTTP acceptance/wamid persistence. This writes no owner chat turn.
        await recordSignedStatus(event);
        await recordSignedStaffScheduleStatus(event);
      }
    }
  }catch {
    // If earlier changes were inserted, their unique wamid makes a replay safe.
    return answer(503,"Queue unavailable");
  }
  return answer(200,"OK");
}
