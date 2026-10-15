import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getMenuItemsForEdit } from "@/lib/data/getMenuItemsForEdit";
import { readSchedulingFoundation } from "@/lib/scheduling/foundation.server";

type Scoped = {businessId:string};
const q=(missingInputs:string[]=[],estimatedInputs:string[]=[])=>({
  level:missingInputs.length?"low" as const:estimatedInputs.length?"medium" as const:"high" as const,
  missingInputs,estimatedInputs,staleInputs:[] as string[],
});
const absent=(reason:string)=>({available:false as const,value:null,quality:q([reason])});
const present=<T>(value:T,missing:string[]=[],estimated:string[]=[])=>({
  available:true as const,value,quality:q(missing,estimated),
});
const MAX_RECORDS=500;

/** Bound by authorizedOwnerP1, plus invoker RLS and explicit business_id in each query.
 * These are narrow public owner projections, not copies of private source rows.
 */
export async function readP1BusinessProfile({businessId}:Scoped) {
  if(!businessId)return absent("scope_missing");
  const client=await createServerSupabaseClient();
  const [business,locations]=await Promise.all([
    client.from("businesses").select("id,name,timezone,currency,opened_on").eq("id",businessId).single(),
    client.from("locations").select("id,name,address_line1,city,region,country_code")
      .eq("business_id",businessId).order("id").limit(101),
  ]);
  if(business.error||!business.data||business.data.id!==businessId||locations.error||!locations.data||
     locations.data.length>100)return absent("business_profile_incomplete");
  return present({
    businessId:business.data.id,name:business.data.name,timezone:business.data.timezone,
    currency:business.data.currency,openedOn:business.data.opened_on,
    locations:locations.data.map(location=>({
      id:location.id,name:location.name,addressLine1:location.address_line1,
      city:location.city,region:location.region,countryCode:location.country_code,
    })),
  });
}

/** Reuses the exact Menu editor source and existing canonical recipe calculations.
 * Recipe-line display cost is intentionally NOT promoted to rounded integer cents:
 * its current editor representation can legitimately be fractional cents.
 */
export async function readP1Recipe({businessId}:Scoped,productId:string) {
  if(!businessId)return absent("scope_missing");
  const catalog=await getMenuItemsForEdit();
  if(catalog.items.length>MAX_RECORDS)return absent("menu_result_over_limit");
  const item=catalog.items.find(p=>p.id===productId);
  if(!item)return absent("product_not_found");
  if(item.recipe.length>200)return absent("recipe_result_over_limit");
  return present({id:item.id,name:item.name,priceCents:item.priceCents,
    costStatus:item.costStatus,recipe:item.recipe.map(line=>({
      ingredientId:line.ingredientId,ingredientName:line.ingredientName,
      baseUnit:line.baseUnit,quantity:line.quantity,displayUnit:line.displayUnit,
      displayQuantity:line.displayQuantity,priceSource:line.priceSource,
    })),
  },item.costStatus==="READY"?[]:["recipe_cost_incomplete"]);
}

export async function readP1Ingredients({businessId}:Scoped) {
  if(!businessId)return absent("scope_missing");
  const catalog=await getMenuItemsForEdit();
  if(catalog.ingredients.length>MAX_RECORDS)return absent("ingredients_result_over_limit");
  return present(catalog.ingredients);
}

export async function readP1EmployeeWages({businessId}:Scoped) {
  if(!businessId)return absent("scope_missing");
  const client=await createServerSupabaseClient();
  const {data,error}=await client.from("employees")
    .select("id,display_name,role,active,default_hourly_wage_cents,wage_period,wage_amount_cents")
    .eq("business_id",businessId).order("id").limit(MAX_RECORDS+1);
  if(error||!data||data.length>MAX_RECORDS)return absent("staff_result_incomplete");
  // Keep unknown wages NULL; a NULL is never $0 hourly labor.
  return present(data.map(row=>({
    id:row.id,name:row.display_name,role:row.role,active:row.active,
    defaultHourlyWageCents:row.default_hourly_wage_cents,
    wagePeriod:row.wage_period??"hour",wageAmountCents:row.wage_amount_cents,
    wageKnown:(typeof row.wage_amount_cents==="number"&&row.wage_amount_cents>0) ||
      (typeof row.default_hourly_wage_cents==="number"&&row.default_hourly_wage_cents>0),
    wageProvenance:(typeof row.wage_amount_cents==="number"&&row.wage_amount_cents>0) ||
      (typeof row.default_hourly_wage_cents==="number"&&row.default_hourly_wage_cents>0)
      ? "recorded_positive" : "unverified_zero_or_missing",
  })),data.some(row=>(row.wage_amount_cents??0)<=0&&(row.default_hourly_wage_cents??0)<=0)
    ? ["missing_employee_wages"]:[]);
}

/** Supplier quote = owner-reported evidence, never live inventory or verified purchase. */
export async function readP1SupplierQuotes({businessId}:Scoped) {
  if(!businessId)return absent("scope_missing");
  const client=await createServerSupabaseClient();
  const {data,error}=await client.from("ai_supplier_quotes")
    .select("id,supplier_name,item_name,price_cents,package_count,package_unit,source_kind,source_url,quoted_on,evidence_status,created_at")
    .eq("business_id",businessId).order("created_at",{ascending:false}).limit(41);
  if(error||!data)return absent("supplier_quotes_unavailable");
  return present({items:data.slice(0,40).map(row=>({
    id:row.id,supplierName:row.supplier_name,itemName:row.item_name,
    priceCents:row.price_cents,packageCount:row.package_count,
    packageUnit:row.package_unit,sourceKind:row.source_kind,
    sourceUrl:row.source_url,quotedOn:row.quoted_on,
    evidenceStatus:row.evidence_status,createdAt:row.created_at,
  })),truncated:data.length>40},[
    ...(data.length>40?["quote_list_truncated"]:[]),
    ...(data.length>0?["supplier_quotes_owner_reported_not_verified"]:[]),
  ]);
}

/** Natural language rules are guidance, not policy/approval grants. */
export async function readP1OwnerRules({businessId}:Scoped) {
  if(!businessId)return absent("scope_missing");
  const client=await createServerSupabaseClient();
  const {data,error}=await client.from("ai_team_rules")
    .select("id,agent_id,instruction,status,version,updated_at")
    .eq("business_id",businessId).eq("status","active")
    .order("updated_at",{ascending:false}).limit(21);
  if(error||!data)return absent("owner_rules_unavailable");
  return present({rules:data.slice(0,20).map(row=>({
    id:row.id,agentId:row.agent_id,instruction:row.instruction,
    status:row.status,version:row.version,updatedAt:row.updated_at,
    isExecutionAuthority:false,
  })),truncated:data.length>20},data.length>20?["rules_list_truncated"]:[]);
}

/** PR #72 foundation stays feature-disabled until independently activated.
 * Never export its audit ledger, private wage attestations, or full raw rows.
 */
export async function readP1SchedulingFoundation({businessId}:Scoped) {
  if(!businessId)return absent("scope_missing");
  const result=await readSchedulingFoundation();
  if(!result.ok)return absent(result.error==="disabled"?"scheduling_not_activated":"scheduling_unavailable");
  const kinds=["availability_rule","availability_exception","preferences","preference_window",
    "qualification_type","qualification","coverage","compensation"] as const;
  return present({enabled:true,recordCounts:Object.fromEntries(
    kinds.map(kind=>[kind,result.records[kind].length]),
  )},["foundation_summary_only_no_optimizer_or_accepted_schedule"]);
}

export async function readP1ExpenseEntries({businessId}:Scoped,period:{from:string;to:string}) {
  if(!businessId)return absent("scope_missing");
  const client=await createServerSupabaseClient();
  const {data,error}=await client.from("expenses")
    .select("id,spent_on,category_code,amount_cents,status,source")
    .eq("business_id",businessId).gte("spent_on",period.from).lte("spent_on",period.to)
    .order("spent_on",{ascending:false}).limit(MAX_RECORDS+1);
  if(error||!data||data.length>MAX_RECORDS)return absent("expenses_result_incomplete");
  return present(data.map(row=>({
    id:row.id,spentOn:row.spent_on,categoryCode:row.category_code,
    amountCents:row.amount_cents,status:row.status,source:row.source,
  })),data.some(row=>row.status==="estimated")?["estimated_expense_rows"] : []);
}
