import "server-only";
import {z} from "zod";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {readCanonicalView} from "@/lib/data/canonical/reads.server";
import {projectInventoryEvidence, type InventoryEvidenceRow} from "@/lib/calc/inventoryEvidence";

export type InventoryEvidenceRead={
 date:string;rows:InventoryEvidenceRow[];missing:string[];truncated:boolean
};

/** Pantry reads precisely the same invoker-RLS canonical view as Supervisor.
 * A session-selected café and owner membership are mandatory; no client or
 * model gets to select a business identity or read the private sync-state table.
 */
export async function readInventoryEvidence(date:string):Promise<InventoryEvidenceRead>{
 const valid=z.iso.date().safeParse(date);
 if(!valid.success)throw new Error("inventory_invalid_date");
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 if(!user)throw new Error("sign_in_required");
 const businessId=await getActiveBusinessId(user.id);
 const {data:membership,error:membershipError}=await db.from("memberships")
  .select("role").eq("business_id",businessId).eq("user_id",user.id).maybeSingle();
 if(membershipError||membership?.role!=="owner")throw new Error("owner_required");
 const result=await readCanonicalView(db,businessId,"cv_inventory",
  {dateFrom:date,dateTo:date},100);
 if(result.error)throw new Error("inventory_reader_unavailable");
 const projected=projectInventoryEvidence(result.rows,100);
 return {date,rows:projected.rows,
  missing:[...new Set([...result.notes,...projected.missing])],
  truncated:result.truncated||projected.truncated};
}
