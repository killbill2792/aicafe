import "server-only";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getMenuItemsForEdit } from "@/lib/data/getMenuItemsForEdit";
import { foundationTables } from "@/lib/scheduling/foundationSchemas";

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
  if(process.env.SCHEDULING_FOUNDATION_ENABLED!=="true")
    return absent("scheduling_not_activated");
  const client=await createServerSupabaseClient();
  // Count-only queries avoid loading the full foundation audit/worker roster
  // merely to produce a P1 summary. All tables are RLS + tenant scoped.
  const kinds=Object.keys(foundationTables) as Array<keyof typeof foundationTables>;
  const counts=await Promise.all(kinds.map(async kind=>{
    const {count,error}=await client.from(foundationTables[kind])
      .select("id",{count:"exact",head:true}).eq("business_id",businessId);
    return {kind,count,error};
  }));
  if(counts.some(result=>result.error||result.count===null||
    !Number.isSafeInteger(result.count)||result.count<0))
    return absent("scheduling_foundation_unavailable");
  return present({enabled:true,recordCounts:Object.fromEntries(
    counts.map(result=>[result.kind,result.count]),
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

/** Bills are recurring obligations, NOT actual cash expense entries. */
export async function readP1RecurringBillRows({businessId}:Scoped) {
  if(!businessId)return absent("scope_missing");
  const client=await createServerSupabaseClient();
  const {data,error}=await client.from("recurring_costs")
    .select("id,category_code,label,amount_cents,frequency,due_day,is_estimate")
    .eq("business_id",businessId).is("active_to",null)
    .order("id").limit(MAX_RECORDS+1);
  if(error||!data||data.length>MAX_RECORDS)return absent("recurring_bills_incomplete");
  return present(data.map(r=>({
    id:r.id,categoryCode:r.category_code,label:r.label,amountCents:r.amount_cents,
    frequency:r.frequency,dueDay:r.due_day,isEstimate:r.is_estimate,
  })),[],data.some(r=>r.is_estimate)?["estimated_recurring_obligation_rows"]:[]);
}

/** Independent bounded read; never fetches the complete historical task inbox.
 * Total ordering (created_at, id) makes pages deterministic for a stable dataset.
 * Both initial and subsequent pages disclose whether more records exist, without
 * forwarding task payload/evidence, worker identities or response history.
 */
export async function readP1TaskPage({businessId}:Scoped,page:number=0) {
  if(!businessId || !Number.isInteger(page) || page<0 || page>250)
    return absent("task_page_invalid");
  const client=await createServerSupabaseClient();
  const size=40, start=page*size;
  const {data,error}=await client.from("operating_tasks")
    .select("id,business_id,agent_id,kind,status,created_at,resolved_at")
    .eq("business_id",businessId)
    .order("created_at",{ascending:false})
    .order("id",{ascending:false})
    .range(start,start+size);
  if(error || !data || data.length>size+1 || data.some(r=>r.business_id!==businessId))
    return absent("task_page_unavailable");
  const hasMore=data.length>size;
  const items=data.slice(0,size).map(row=>({
    id:row.id,agentId:row.agent_id,kind:row.kind,status:row.status,
    createdAt:row.created_at,resolvedAt:row.resolved_at,
  }));
  return present({items,page,hasMore,nextPage:hasMore?page+1:null},
    hasMore||page>0?["task_inbox_page_only"]:[]);
}
