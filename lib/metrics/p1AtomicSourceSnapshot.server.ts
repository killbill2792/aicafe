import "server-only";
import { z } from "zod";
import { authorizedOwnerP1 } from "./p1Readers.server";
import { createServerSupabaseClient } from "@/lib/supabase/server";

/** Raw facts from ONE DB statement, not the P1 result for a specific domain.
 * Domain projection still has to validate each record, period and coverage
 * before it can upgrade any operand's actuality/completeness.
 */
const cents=z.number().int().safe();
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const bounded=<T extends z.ZodType>(row:T,cap:number)=>z.array(row).max(cap);
export const atomicP1SourceSchema=z.strictObject({
  contract:z.literal("p1.authoritative_snapshot.v1"),
  businessId:z.string().uuid(),
  revision:z.string().regex(/^[1-9]\d{0,18}$/).refine(n=>
    n.length<19 || n<="9223372036854775807"),
  timezone:z.string().min(1),currency:z.string().min(3).max(3),
  payroll:z.strictObject({
    rate:z.number().finite().min(0).max(1),
    status:z.enum(["estimated","confirmed"]),
    source:z.string().min(1).max(500),
  }),
  sources:z.strictObject({
    menu:bounded(z.strictObject({id:z.string().uuid(),name:z.string(),
      price_cents:cents.nullable(),is_active:z.boolean(),category:z.string().nullable()}),501),
    ingredients:bounded(z.strictObject({
      id:z.string().uuid(),name:z.string(),base_unit:z.enum(["g","ml","each"])}),501),
    ingredientPrices:bounded(z.strictObject({
      id:z.string().uuid(),ingredient_id:z.string().uuid(),effective_from:day,
      cost_per_base_unit_micros:cents,source:z.enum(["manual","receipt","statement","invoice"])}),501),
    recipes:bounded(z.strictObject({
      menu_item_id:z.string().uuid(),ingredient_id:z.string().uuid(),
      quantity:z.number().finite().nonnegative()}),501),
    employees:bounded(z.strictObject({
      id:z.string().uuid(),display_name:z.string(),active:z.boolean(),role:z.string().nullable(),
      default_hourly_wage_cents:cents.nullable(),wage_period:z.enum(["hour","month","year"]),
      wage_amount_cents:cents.nullable()}),501),
    dailyRollups:bounded(z.strictObject({
      business_date:day,net_sales_cents:cents,orders_count:cents,drinks_count:cents,
      ingredients_cents:cents,staff_wages_cents:cents,staff_tax_cents:cents,
      card_fees_cents:cents,sales_data_status:z.enum(["actual","missing"]),
      staff_tax_status:z.enum(["actual","estimated"])}),367),
    expenses:bounded(z.strictObject({
      id:z.string().uuid(),spent_on:day,amount_cents:cents,
      status:z.enum(["actual","estimated"]),source:z.string(),category_code:z.string()}),501),
    recurringCosts:bounded(z.strictObject({
      id:z.string().uuid(),label:z.string(),amount_cents:cents,
      frequency:z.enum(["monthly","weekly","quarterly","yearly"]),
      is_estimate:z.boolean(),active_from:day,active_to:day.nullable()}),501),
    imports:bounded(z.strictObject({
      id:z.string().uuid(),kind:z.enum(["sales","labor"]),
      status:z.enum(["processing","needs_review","needs_wage_review","done","failed"]),
      date_from:day.nullable(),date_to:day.nullable(),group_count:cents}),101),
  }),
  truncated:z.strictObject({
    menu:z.boolean(),ingredients:z.boolean(),ingredientPrices:z.boolean(),
    recipes:z.boolean(),employees:z.boolean(),dailyRollups:z.boolean(),
    expenses:z.boolean(),recurringCosts:z.boolean(),imports:z.boolean(),
  }),
  coverage:z.literal("not_proven_by_revision"),
}).superRefine((v,ctx)=>{
  for(const name of Object.keys(v.truncated) as Array<keyof typeof v.truncated>){
    const cap=name==="dailyRollups"?366:name==="imports"?100:500;
    if(v.truncated[name]!==((v.sources[name] as unknown[]).length>cap))
      ctx.addIssue({code:"custom",message:"inconsistent source truncation:"+name});
  }
});
export type AtomicP1SourceSnapshot=z.infer<typeof atomicP1SourceSchema>;
type SnapshotOutcome=
  | {status:"available";snapshot:AtomicP1SourceSnapshot}
  | {status:"unavailable";reason:"rpc_not_installed"|"unauthorized_or_unconfigured"|"invalid_source_snapshot"};

/** One authorized RPC call = one MVCC epoch+data snapshot.
 * Never synthesize revisions if the migration is unapplied or its result lacks
 * the DB ledger. Do not run multiple independent RPCs and join their rows.
 */
export async function readAuthorizedAtomicP1SourceSnapshot():Promise<SnapshotOutcome>{
  try{
    const {identity}=await authorizedOwnerP1();
    if(!identity.businessId)return {status:"unavailable",reason:"unauthorized_or_unconfigured"};
    const client=await createServerSupabaseClient();
    const {data,error}=await client.rpc("p1_authoritative_source_snapshot",{
      p_business_id:identity.businessId,
    });
    // A successful NULL RPC result means an authoritative ledger/owner row
    // was not returned; it is an integrity failure, not a missing migration.
    // Only an actual RPC error can represent an uninstalled RPC.
    if(error){
      // Missing migration is a narrow compatibility case. Permission denied,
      // schema corruption, network errors and RPC execution failures are NOT.
      const code=(error as {code?:unknown}).code;
      const message=String((error as {message?:unknown}).message??"").toLowerCase();
      // An undefined dependency INSIDE an installed RPC may also be 42883.
      // Downgrade only when the missing function is THIS precise RPC.
      if(code==="PGRST202"&&
        message.includes("p1_authoritative_source_snapshot"))
        return {status:"unavailable",reason:"rpc_not_installed"};
      return {status:"unavailable",reason:"unauthorized_or_unconfigured"};
    }
    if(!data)return {status:"unavailable",reason:"invalid_source_snapshot"};
    const parsed=atomicP1SourceSchema.safeParse(data);
    if(!parsed.success || parsed.data.businessId!==identity.businessId ||
       parsed.data.timezone!==identity.timezone ||
       parsed.data.currency!==identity.currency)
      return {status:"unavailable",reason:"invalid_source_snapshot"};
    return {status:"available",snapshot:parsed.data};
  }catch{
    return {status:"unavailable",reason:"unauthorized_or_unconfigured"};
  }
}
