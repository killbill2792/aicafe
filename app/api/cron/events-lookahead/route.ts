import {NextResponse} from "next/server";
import {verifyBearer} from "@/lib/security/bearer";
import {runEventsLookahead} from "@/lib/events/eventsLookahead.server";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=300;
const respond=(status:number,body:unknown)=>NextResponse.json(body,{status,
  headers:{"Cache-Control":"no-store"}});

/** Search and AI planning are never invoked by an app-screen request. */
export async function GET(request:Request){
  if(!verifyBearer(request,process.env.CRON_SECRET))
    return respond(401,{error:"unauthorized"});
  if(process.env.EVENTS_LOOKAHEAD_ENABLED!=="true")
    return respond(503,{disabled:true});
  try{return respond(200,await runEventsLookahead());}
  catch{return respond(503,{error:"events_lookahead_unavailable"});}
}
