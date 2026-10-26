"use server";
import {z} from "zod";
import {createHash} from "node:crypto";
import {revalidatePath} from "next/cache";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {recordPurchases,type PurchaseLineInput,type PurchaseResult} from "@/lib/inventory/recordPurchases.server";
import {detectCsvColumns,toDateStr,toCents} from "@/lib/pos/csv/csvUtils";
import {parseOwnerDecimal} from "@/lib/calc/localeDecimal";

async function ownerScope(){
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 if(!user)throw new Error("sign_in_required");
 const businessId=await getActiveBusinessId(user.id);
 const {data:member,error}=await db.from("memberships").select("role,businesses(is_demo)")
   .eq("user_id",user.id).eq("business_id",businessId).maybeSingle();
 const raw=member?.businesses as unknown as {is_demo:boolean}|{is_demo:boolean}[]|null;
 const demo=Array.isArray(raw)?raw[0]?.is_demo:raw?.is_demo;
 if(error||member?.role!=="owner"||demo!==false)throw new Error("owner_required");
 return {db,businessId};
}
export async function saveBulkPurchases(lines:PurchaseLineInput[]):Promise<PurchaseResult[]>{
 const result=await recordPurchases(lines,"bulk",null);
 if(result.some(line=>line.ok))revalidatePath("/menu/pantry");
 return result;
}
const uuid=z.string().uuid();
export async function voidInventoryPurchase(lineId:string):Promise<{ok:boolean;error?:string}>{
 const valid=uuid.safeParse(lineId);
 if(!valid.success)return {ok:false,error:"invalid_line_id"};
 try{
  const {db,businessId}=await ownerScope();
  const {data,error}=await db.rpc("pantry_void_purchase_line",{
   p_business_id:businessId,p_line_id:lineId
  });
  if(error)return {ok:false,error:"save_failed"};
  if(!data)return {ok:false,error:"already_voided_or_missing"};
  revalidatePath("/menu/pantry");return {ok:true};
 }catch{return {ok:false,error:"owner_required"};}
}
export async function editInventoryPurchase(line:PurchaseLineInput):Promise<PurchaseResult>{
 try{
  const {db,businessId}=await ownerScope();
  const {data,error}=await db.from("pantry_stock_purchases")
   .select("source,source_ref,expense_line_id").eq("business_id",businessId).eq("line_id",line.lineId)
   .is("voided_at",null).maybeSingle();
  if(error||!data)return {lineId:line.lineId,ok:false,error:"purchase_not_found"};
  if(!line.expectedRevision)return {lineId:line.lineId,ok:false,error:"missing_revision"};
  const result=await recordPurchases([{...line,expenseLineId:data.expense_line_id}],data.source as import("@/lib/inventory/recordPurchases.server").PurchaseSource,data.source_ref);
  if(result[0]?.ok)revalidatePath("/menu/pantry");
  return result[0]??{lineId:line.lineId,ok:false,error:"save_failed"};
 }catch{return {lineId:line.lineId,ok:false,error:"owner_required"};}
}
export type PurchaseCsvMapping={date:string;item:string;quantity:string;unit:string;cost?:string};
const mappingSchema=z.strictObject({date:z.string().min(1),item:z.string().min(1),
 quantity:z.string().min(1),unit:z.string().min(1),cost:z.string().optional()});
function stableUuid(seed:string):string{
 const hex=createHash("sha256").update(seed).digest("hex").slice(0,32).split("");
 hex[12]="5";hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);
 const s=hex.join("");return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join("-");
}
export async function importInventoryCsv(content:string,rawMapping:PurchaseCsvMapping,locale:"en"|"es"|"ar"="en"):Promise<PurchaseResult[]>{
 const mapping=mappingSchema.safeParse(rawMapping);
 if(!mapping.success||content.length>2_000_000)return [{lineId:"csv",ok:false,error:"invalid_csv"}];
 const {businessId,db}=await ownerScope();
 const parsed=detectCsvColumns(content);
 if(parsed.rows.length>500)return [{lineId:"csv",ok:false,error:"too_many_rows"}];
 if(Object.values(mapping.data).some(column=>column&&!parsed.headers.includes(column)))
   return [{lineId:"csv",ok:false,error:"invalid_columns"}];
 const {data:ingredients,error}=await db.from("ingredients").select("id,name").eq("business_id",businessId).limit(3000);
 if(error||!ingredients)return [{lineId:"csv",ok:false,error:"ingredients_unavailable"}];
 const byName=new Map<string,string|null>();
 for(const ingredient of ingredients){
  const name=ingredient.name.trim().toLocaleLowerCase();
  byName.set(name,byName.has(name)?null:ingredient.id);
 }
 const fingerprint=createHash("sha256").update(content).digest("hex");
 const invalid:PurchaseResult[]=[];
 const lines:PurchaseLineInput[]=parsed.rows.flatMap((row,i)=>{
  const name=String(row[mapping.data.item]??"").trim().toLocaleLowerCase();
  const value=String(mapping.data.cost?row[mapping.data.cost]??"":"").trim();
  const costValue=value?parseOwnerDecimal(value,locale):null;
  const costCents=costValue===null?null:toCents(String(costValue));
  const quantity=parseOwnerDecimal(String(row[mapping.data.quantity]??""),locale);
  const lineId=stableUuid(businessId+":"+fingerprint+":"+i);
  if(value&&(costValue===null||!Number.isSafeInteger(costCents))){invalid.push({lineId,ok:false,error:"invalid_cost"});return [];}
  if(quantity===null||quantity<=0){invalid.push({lineId,ok:false,error:"invalid_quantity"});return [];}
  return [{lineId,
   ingredientId:byName.get(name)??null,date:toDateStr(row[mapping.data.date]??""),
   quantity,unit:String(row[mapping.data.unit]??"").trim(),
   costCents}];
 });
 const result=lines.length?await recordPurchases(lines,"csv",fingerprint):[];
 if(result.some(r=>r.ok))revalidatePath("/menu/pantry");
 return [...result,...invalid];
}
