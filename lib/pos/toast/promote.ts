import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {recomputeDailyRollup} from "@/lib/pos/rollup";
import {rebuildSalesFactRollups} from "@/lib/pos/salesFactRollups";
import {ToastApiError} from "./client";
import {z} from "zod";
export const promoteSchema=z.object({
 businessId:z.uuid(),locationId:z.uuid(),restaurantGuid:z.uuid(),
 businessDate:z.iso.date(),checksum:z.string().regex(/^[a-f0-9]{64}$/),
 confirmPromotion:z.literal(true),
}).strict();
export async function promoteVerifiedToastDay(
 db:SupabaseClient,p:z.infer<typeof promoteSchema>) {
 const {data:count,error}=await db.rpc("toast_promote_reconciled_day",{
   p_business_id:p.businessId,p_location_id:p.locationId,
   p_restaurant_guid:p.restaurantGuid,p_business_date:p.businessDate,
   p_expected_sha256:p.checksum
 });
 if(error||!Number.isSafeInteger(count)) {
   // Do not leak source order IDs or sensitive DB constraints in owner-facing errors.
   throw new ToastApiError("invalid_response");
 }
 try {
   // Use existing canonical rollup, never another independent sales calculator.
   // No verified zero is promoted merely because an owner typed a matching zero report.
   // The existing guarded RPC remains unchanged. Enrich from its exact staged
   // snapshot, not from fabricated order metadata, then rebuild derived facts.
   const {data:pilot,error:pilotError}=await db.from("toast_pilot_days")
      .select("orders_snapshot").eq("business_id",p.businessId)
      .eq("restaurant_guid",p.restaurantGuid).eq("location_id",p.locationId)
      .eq("business_date",p.businessDate).eq("snapshot_sha256",p.checksum)
      .eq("state","promoted").single();
   if(pilotError||!pilot||!Array.isArray(pilot.orders_snapshot))throw new Error("Missing verified Toast snapshot");
   const {data:staff,error:staffError}=await db.from("employees")
      .select("id,pos_team_member_id").eq("business_id",p.businessId);
   if(staffError)throw staffError;
   const byPos=new Map((staff??[]).map(e=>[e.pos_team_member_id,e.id]));
   // Guarded Toast employees are linked through the owner-approved directory,
   // not by rewriting the canonical employee's POS identity.
   const {data:directory,error:directoryError}=await db.from("toast_employee_directory")
      .select("employee_guid,linked_employee_id").eq("business_id",p.businessId)
      .eq("restaurant_guid",p.restaurantGuid); // Historic approved links remain valid after roster deletion
   if(directoryError)throw directoryError;
   const approved=new Map((directory??[]).filter(e=>e.linked_employee_id)
     .map(e=>[e.employee_guid,e.linked_employee_id]));
   for(const raw of pilot.orders_snapshot){
      if(!raw||typeof raw!=="object")throw new Error("Invalid Toast order snapshot");
      const rec=raw as Record<string,unknown>;
      if(typeof rec.posOrderId!=="string"||!rec.posOrderId.startsWith(`toast:${p.restaurantGuid}:`))throw new Error("Untrusted Toast snapshot ID");
      const employee=typeof rec.posEmployeeId==="string"?rec.posEmployeeId:null;
      const employeeId=employee?approved.get(employee)??byPos.get(`toast:${p.restaurantGuid}:${employee}`)??null:null;
      const {data:order,error:orderError}=await db.from("orders")
        .update({employee_id:employeeId,
          dining_option:typeof rec.diningOption==="string"?rec.diningOption:null,
          source_channel:typeof rec.sourceChannel==="string"?rec.sourceChannel:null,
          guest_count:Number.isInteger(rec.guestCount)&&Number(rec.guestCount)>=0&&Number(rec.guestCount)<=32767?rec.guestCount:null})
        .eq("business_id",p.businessId).eq("pos_order_id",rec.posOrderId)
        .select("id").single();
      if(orderError||!order)throw new Error("Toast fact enrichment failed");
      if(Array.isArray(rec.lines)){
        const byName=new Map<string,Set<string|null>>();
        for(const line of rec.lines){
          if(!line||typeof line!=="object"||typeof line.name!=="string")continue;
          const categories=byName.get(line.name)??new Set<string|null>();
          categories.add(typeof line.category==="string"?line.category:null);
          byName.set(line.name,categories);
        }
        for(const [name,categories] of byName){
          if(categories.size!==1)continue; // indistinguishable repeated lines
          const {error}=await db.from("order_lines").update({category:[...categories][0]})
           .eq("order_id",order.id).eq("name",name);
          if(error)throw error;
        }
      }
   }
   const {data:business,error:tzError}=await db.from("businesses").select("timezone").eq("id",p.businessId).single();
   if(tzError)throw tzError;
   await rebuildSalesFactRollups(db,p.businessId,[p.businessDate],business.timezone);
   await recomputeDailyRollup(db,p.businessId,p.businessDate);
   // Legacy rollup can return without surfacing its final upsert error.
   // Verify the canonical revenue aggregate before claiming that the write worked.
   const [{data:allOrders,error:ordersError},{data:rollup,error:rollupError}]=await Promise.all([
     db.from("orders").select("net_sales_cents").eq("business_id",p.businessId)
       .eq("business_date",p.businessDate),
     db.from("daily_rollups").select("net_sales_cents").eq("business_id",p.businessId)
       .eq("business_date",p.businessDate).maybeSingle(),
   ]);
   if(ordersError||rollupError||!rollup)throw new ToastApiError("unavailable");
   const sum=(allOrders??[]).reduce((total,row)=>total+Number(row.net_sales_cents),0);
   if(!Number.isSafeInteger(sum)||sum!==Number(rollup.net_sales_cents))
     throw new ToastApiError("unavailable");
 } catch {
   // Data transaction may have committed; remain retryable and do not pretend rollup refreshed.
   await db.from("toast_pilot_days").update({last_error_category:"rollup_unavailable"})
    .eq("business_id",p.businessId).eq("restaurant_guid",p.restaurantGuid)
    .eq("business_date",p.businessDate);
   throw new ToastApiError("unavailable");
 }
 return {ordersPromoted:count,canonical:true,zeroDayVerified:false};
}
