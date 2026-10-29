/** Run with: NODE_OPTIONS=--conditions=react-server npx tsx scripts/toast-raw-capture-daily.ts
 * Captures every Toast endpoint for each verified café's recent closed days that are
 * not yet complete. Requires server environment credentials. Prints counts only. */
import {createClient} from "@supabase/supabase-js";
import {runDailyToastCapture} from "../lib/pos/toast/dailyCapture.server";

const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
if(!url||!key)throw new Error("Missing server Supabase environment");
const db=createClient(url,key,{auth:{autoRefreshToken:false,persistSession:false}});
const summary=await runDailyToastCapture(db);
process.stdout.write(JSON.stringify(summary)+"\n");
// Partial and skipped (busy/cooldown) captures retry on the next run; only failures fail the job.
if(summary.failed)process.exitCode=1;
