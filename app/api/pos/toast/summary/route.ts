import {NextResponse} from "next/server";
import {z} from "zod";
import {GUID} from "@/lib/pos/toast/client";
import {authorizeToastOwner} from "@/lib/pos/toast/ownerAccess";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {toastSummaryDraft} from "@/lib/calc/toastSummaryInput";
export const dynamic="force-dynamic";
const input=toastSummaryDraft.extend({businessId:GUID,restaurantGuid:GUID,source:z.enum(["typed","photo","csv"])}).strict();
const send=(status:number,data:unknown)=>NextResponse.json(data,{status,headers:{"Cache-Control":"no-store"}});
export async function POST(request:Request){
 if(process.env.TOAST_SETUP_ENABLED!=="true")return send(404,{error:"not_found"});
 const p=input.safeParse(await request.json().catch(()=>null));
 if(!p.success)return send(400,{error:"invalid_summary"});
 const x=p.data;
 if(!await authorizeToastOwner(x.businessId))return send(403,{error:"not_authorized"});
 // Use the signed session, not service-role: the RPC rechecks auth.uid(), ownership and demo.
 const db=await createServerSupabaseClient();
 const configured=Number(process.env.TOAST_RECON_TOLERANCE_CENTS??5);
 const tolerance=Number.isInteger(configured)&&configured>=0&&configured<=100?configured:5;
 const {error}=await db.rpc("toast_save_owner_summary",{p_business_id:x.businessId,
 p_restaurant_guid:x.restaurantGuid,p_date:x.date,p_net:x.netSalesCents,p_orders:x.ordersCount,
 p_discounts:x.discountsCents,p_refunds:x.refundsCents,p_voids:x.voidsCount,p_source:x.source,p_tolerance:tolerance});
 return error?send(422,{error:"summary_not_saved"}):send(200,{saved:true});
}
