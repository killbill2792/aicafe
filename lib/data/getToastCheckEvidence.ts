import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
const evidence=z.object({mode:z.enum(["official","internal"]),reason:z.string(),
 compared:z.number().int().nonnegative(),matched:z.number().int().nonnegative()});
export async function getToastCheckEvidence(db:SupabaseClient,businessId:string){
 const {data,error}=await db.rpc("toast_check_evidence",{p_business_id:businessId});
 if(error)throw new Error("Toast check evidence unavailable");
 return data==null?null:evidence.parse(data);
}
