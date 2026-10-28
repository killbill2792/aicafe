/** Run with: npx tsx scripts/toast-raw-sample.ts --business UUID --date YYYY-MM-DD
 * Requires server environment credentials. No owner session bypass via HTTP. */
import {createClient} from "@supabase/supabase-js";
import {z} from "zod";
import {captureToastRawSample} from "../lib/pos/toast/rawSample.server";
const args=process.argv.slice(2);
const value=(flag:string)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
const business=z.uuid().safeParse(value("--business"));
const day=z.iso.date().safeParse(value("--date"));
if(!business.success||!day.success)throw new Error("Usage: --business <uuid> --date <yyyy-mm-dd>");
const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url||!key)throw new Error("Missing server Supabase environment");
const db=createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});
const result=await captureToastRawSample(business.data,day.data,db);
process.stdout.write(JSON.stringify(result)+"\n");
if(result.skipped||result.failed)process.exitCode=1;
