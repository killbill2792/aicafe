import "server-only";
import {cache} from "react";
import {cookies} from "next/headers";
import {TRACE_COOKIE} from "./navigationMetrics";

/** Cached within one request: a random trace grouping, never a café or user ID. */
const context=cache(async()=>{
  let cookie:string|undefined;
  try {cookie=(await cookies()).get(TRACE_COOKIE)?.value;}catch{/* no request context */}
  return {trace:cookie&&/^[a-f0-9]{16}$/.test(cookie)?cookie:"none",
    request:crypto.randomUUID().replace(/-/g,"").slice(0,12)};
});

/** Existing reader timings extended with privacy-safe request correlation. */
export async function timeReader<T>(
  page:"Home"|"Money"|"Toast"|"Snapshot"|"Staff",
  name:string,
  read:()=>Promise<T>,
):Promise<T> {
  const started=performance.now();
  const metadata=context();
  try{return await read();}
  finally {
    const ms=Math.round(performance.now()-started);
    const {trace,request}=await metadata;
    console.info("[reader-timing] "+page+"."+name+" "+ms+"ms request="+request+" trace="+trace);
  }
}
