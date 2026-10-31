import {MAX_WEBHOOK_BYTES,parseWebhook,verifyChallenge,verifySignature} from "@/lib/whatsapp/webhook";
import {TEST_PHONE_NUMBER_ID} from "@/lib/whatsapp/transport";
import {acceptSignedMessage} from "@/lib/whatsapp/identity.server";
import {recordSignedStatus} from "@/lib/whatsapp/queue.server";
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
    const phoneId=process.env.WHATSAPP_PHONE_NUMBER_ID??TEST_PHONE_NUMBER_ID;
    // This PR is wired only for the supplied Meta developer test sender.
    if(phoneId!==TEST_PHONE_NUMBER_ID)return answer(503,"Not configured");
    events=parseWebhook(bytes,phoneId);
  }catch(error){
    return answer(error instanceof Error&&error.message==="wrong_sender"?403:422,"Invalid event");
  }
  try{
    for(const event of events){
      if(event.type==="message")await acceptSignedMessage(event);
      else await recordSignedStatus(event);
    }
  }catch {
    // If earlier changes were inserted, their unique wamid makes a replay safe.
    return answer(503,"Queue unavailable");
  }
  return answer(200,"OK");
}
