import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PosAdapter,PosOrder,PosCatalogItem,PosEmployee,PosTimecard} from "../types";
import {PosNotConnectedError} from "../types";
import {createToastClient,GUID,ToastApiError,toToastTimestamp} from "./client";
type Range={since:Date;until:Date};
type Discount={nonTaxDiscountAmount?:number|null};
type Selection={salesCategory?:{name?:string|null}|null;displayName?:string|null;item?:{guid:string}|null;quantity:number;price:number;
  voided?:boolean|null;modifiers?:{displayName?:string|null;item?:{guid:string}|null}[]|null;
  refundDetails?:{refundAmount?:number|null}|null;appliedDiscounts?:Discount[]|null};
type Check={amount:number;taxAmount:number;paymentStatus:string;closedDate?:string|null;
  appliedDiscounts?:Discount[]|null;appliedServiceCharges?:unknown[]|null;selections:Selection[];
  payments:{tipAmount?:number|null;refundStatus?:string|null;
    refund?:{refundAmount?:number|null;tipRefundAmount?:number|null}|null}[]};
type Order={guid:string;server?:{guid:string}|null;openedBy?:{guid:string}|null;diningOption?:{name?:string|null}|null;source?:string|null;numberOfGuests?:number|null;closedDate?:string|null;createdInTestMode?:boolean|null;
  deleted?:boolean|null;voided?:boolean|null;modifiedDate?:string|null;checks:Check[]};
const discount=z.object({nonTaxDiscountAmount:z.number().nullish()});
const selection=z.object({salesCategory:z.object({name:z.string().nullish()}).nullish(),displayName:z.string().nullish(),item:z.object({guid:GUID}).nullish(),
  quantity:z.number(),price:z.number(),voided:z.boolean().nullish(),
  modifiers:z.array(z.object({displayName:z.string().nullish(),item:z.object({guid:GUID}).nullish()})).nullish(),
  refundDetails:z.object({refundAmount:z.number().nullish()}).nullish(),
  appliedDiscounts:z.array(discount).nullish()});
const check=z.object({amount:z.number(),taxAmount:z.number(),paymentStatus:z.string(),
  closedDate:z.string().nullish(),appliedDiscounts:z.array(discount).nullish(),
  appliedServiceCharges:z.array(z.unknown()).nullish(),
  selections:z.array(selection),payments:z.array(z.object({
    tipAmount:z.number().nullish(),refundStatus:z.string().nullish(),
    refund:z.object({refundAmount:z.number().nullish(),tipRefundAmount:z.number().nullish()}).nullish()}))});
const ordersSchema=z.array(z.object({guid:GUID,server:z.object({guid:GUID}).nullish(),openedBy:z.object({guid:GUID}).nullish(),diningOption:z.object({name:z.string().nullish()}).nullish(),source:z.string().nullish(),numberOfGuests:z.number().int().min(0).max(32767).nullish(),closedDate:z.string().nullish(),
  createdInTestMode:z.boolean().nullish(),deleted:z.boolean().nullish(),voided:z.boolean().nullish(),modifiedDate:z.string().nullish(),
  checks:z.array(check)}));
/** Whitelist official permitted labor response fields. Credential/passcode and
 * unrelated provider extensions are deliberately stripped, never persisted. */
const laborRefSchema=z.object({guid:GUID,entityType:z.string().nullish(),
  externalId:z.string().nullish()});
const employeeSourceSchema=z.object({guid:GUID,firstName:z.string().nullish(),
  chosenName:z.string().nullish(),lastName:z.string().nullish(),deleted:z.boolean().nullish(),
  createdDate:z.string().nullish(),modifiedDate:z.string().nullish(),
  deletedDate:z.string().nullish(),email:z.string().nullish(),
  phoneNumber:z.string().nullish(),phoneNumberCountryCode:z.string().nullish(),
  externalEmployeeId:z.string().nullish(),v2EmployeeGuid:GUID.nullish(),
  entityType:z.string().nullish(),externalId:z.string().nullish(),
  jobReferences:z.array(laborRefSchema).nullish(),
  wageOverrides:z.array(z.object({jobReference:laborRefSchema,wage:z.number()})).nullish()
});
const employeesSchema=z.array(employeeSourceSchema);
const timeEntrySourceSchema=z.object({guid:GUID,modifiedDate:z.string().nullish(),
  employeeReference:laborRefSchema,jobReference:laborRefSchema.nullish(),
  shiftReference:laborRefSchema.nullish(),inDate:z.string(),outDate:z.string().nullish(),
  hourlyWage:z.number().nullish(),regularHours:z.number().finite().nullish(),
  overtimeHours:z.number().finite().nullish(),deleted:z.boolean().nullish(),
  createdDate:z.string().nullish(),deletedDate:z.string().nullish(),
  businessDate:z.string().nullish(),autoClockedOut:z.boolean().nullish(),
  declaredCashTips:z.number().finite().nullish(),nonCashTips:z.number().finite().nullish(),
  nonCashTipsRoundingLoss:z.number().finite().nullish(),tipsWithheld:z.number().finite().nullish(),
  cashSales:z.number().finite().nullish(),nonCashSales:z.number().finite().nullish(),
  cashGratuityServiceCharges:z.number().finite().nullish(),
  nonCashGratuityServiceCharges:z.number().finite().nullish(),
  breaks:z.array(z.object({guid:GUID.nullish(),
    inDate:z.string().nullish(),outDate:z.string().nullish(),
    paid:z.boolean().nullish(),missed:z.boolean().nullish(),
    waived:z.boolean().nullish(),auditResponse:z.boolean().nullish(),
    breakType:laborRefSchema.nullish()})).nullish()
});
const timeEntriesSchema=z.array(timeEntrySourceSchema);
const shiftSourceSchema=z.object({guid:GUID,employeeReference:laborRefSchema,
  jobReference:laborRefSchema.nullish(),inDate:z.string(),outDate:z.string(),
  deleted:z.boolean().nullish(),createdDate:z.string().nullish(),
  modifiedDate:z.string().nullish(),deletedDate:z.string().nullish(),
  entityType:z.string().nullish(),externalId:z.string().nullish(),
  scheduleConfig:z.object({guid:GUID.nullish(),minAfterClockIn:z.number().nullish(),
    minAfterClockOut:z.number().nullish(),minBeforeClockIn:z.number().nullish(),
    minBeforeClockOut:z.number().nullish()}).nullish()
});
const shiftsSchema=z.array(shiftSourceSchema);
const pricingRulesSchema=z.object({
  sizeSpecificPricingGuid:GUID.nullish(),
  timeSpecificPricingRules:z.array(z.object({
    timeSpecificPrice:z.number().nullish(),basePrice:z.number().nullish(),
    schedule:z.array(z.unknown()).nullish()
  }).passthrough()).nullish(),
  sizeSequencePricingRules:z.array(z.unknown()).nullish()
}).passthrough();
const itemSchema=z.object({
  guid:GUID,name:z.string().min(1),description:z.string().nullish(),
  price:z.number().nullish(),pricingStrategy:z.string().nullish(),
  pricingRules:pricingRulesSchema.nullish(),
  visibility:z.array(z.string().nullable()).nullish(),
  image:z.string().nullish(),plu:z.string().nullish(),sku:z.string().nullish(),
  salesCategory:z.object({name:z.string().nullish()}).passthrough().nullish(),
  modifierGroupReferences:z.array(z.number()).nullish()
}).passthrough();
type MenuGroup={name:string;menuItems:z.infer<typeof itemSchema>[];menuGroups:MenuGroup[];
 availability?:unknown};
const groupSchema:z.ZodType<MenuGroup>=z.lazy(()=>z.object({
  name:z.string(),availability:z.unknown().optional(),
  menuItems:z.array(itemSchema),menuGroups:z.array(groupSchema)
}).passthrough());
const menusSchema=z.object({restaurantGuid:GUID,menus:z.array(
  z.object({name:z.string().nullish(),availability:z.unknown().optional(),
    menuGroups:z.array(groupSchema)}).passthrough()),
  modifierGroupReferences:z.record(z.string(),z.object({
    guid:GUID,name:z.string().nullish(),minSelections:z.number().int().nullish(),
    maxSelections:z.number().int().nullish(),requiredMode:z.string().nullish(),
    pricingStrategy:z.string().nullish(),pricingRules:pricingRulesSchema.nullish(),
    modifierOptionReferences:z.array(z.number())
  }).passthrough()).default({}),
  modifierOptionReferences:z.record(z.string(),z.object({
    guid:GUID,name:z.string().min(1),price:z.number().nullish(),
    pricingStrategy:z.string().nullish(),pricingRules:pricingRulesSchema.nullish()
  }).passthrough()).default({})
}).passthrough();
const jobSourceSchema=z.object({
  guid:GUID,title:z.string().nullish(),defaultWage:z.number().nullish(),
  wageFrequency:z.enum(["HOURLY","SALARY"]).nullish(),deleted:z.boolean().nullish(),
  code:z.string().nullish(),tipped:z.boolean().nullish(),
  excludeFromReporting:z.boolean().nullish(),createdDate:z.string().nullish(),
  modifiedDate:z.string().nullish(),deletedDate:z.string().nullish(),
  entityType:z.string().nullish(),externalId:z.string().nullish()
});
const toastJobSchema=z.array(jobSourceSchema);
/** Preserve only the approved fields even if a client/test double supplies an
 * unvalidated payload. Unknown credentials must never escape this adapter. */
function validatedLaborSource<T>(schema:z.ZodType<T>,payload:unknown):T {
  const parsed=schema.safeParse(payload);
  if(!parsed.success)throw new ToastApiError("invalid_response");
  return parsed.data;
}
const metadataSchema=z.object({restaurantGuid:GUID,lastUpdated:z.string().min(1)});
function validRange(range:Range) {
  if(!Number.isFinite(range.since.getTime())||!Number.isFinite(range.until.getTime())||
    range.since>=range.until||range.until.getTime()-range.since.getTime()>30*86400000)
    throw new ToastApiError("invalid_response");
}
function timestamp(value:string):string {
  const date=new Date(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if(!Number.isFinite(date.getTime()))throw new ToastApiError("invalid_response");
  return date.toISOString();
}
/** Toast financial values use decimal DOLLARS; canonical AI CAFE uses integer cents. */
export function toastMoneyCents(value:number):number {
  if(!Number.isFinite(value))throw new ToastApiError("invalid_response");
  // Round half away from zero; sub-cent provider values must not abort a day.
  const cents=Math.sign(value)*Math.round(Math.abs(value)*100+1e-9);
  if(!Number.isSafeInteger(cents))throw new ToastApiError("invalid_response");
  return cents;
}
const cents=(v:number|null|undefined)=>toastMoneyCents(v??0);
function appliedDiscounts(ds:Discount[]|null|undefined) {
  return (ds??[]).reduce((total,d)=>{
    if(d.nonTaxDiscountAmount==null)throw new ToastApiError("invalid_response");
    return total+cents(d.nonTaxDiscountAmount);
  },0);
}
export function normalizeToastOrder(order:Order,restaurantGuid:string):PosOrder|null {
  if(order.createdInTestMode||order.deleted||order.voided)return null;
  if(order.checks.some(c=>c.paymentStatus!=="CLOSED"||!c.closedDate))return null;
  if(order.checks.some(c=>(c.appliedServiceCharges?.length??0)>0||
     c.selections.some(s=>s.voided)))throw new ToastApiError("invalid_response");
  if(!order.closedDate)throw new ToastApiError("invalid_response");
  let netBeforeRefunds=0,discounts=0,refunds=0,tax=0,tips=0;
  const lines:PosOrder["lines"]=[];
  for(const c of order.checks) {
    netBeforeRefunds+=cents(c.amount);
    discounts+=appliedDiscounts(c.appliedDiscounts);
    tax+=cents(c.taxAmount);
    for(const s of c.selections) {
      discounts+=appliedDiscounts(s.appliedDiscounts);
      const refunded=s.voided?0:cents(s.refundDetails?.refundAmount);
      refunds+=refunded;
      if(!Number.isFinite(s.quantity)||s.quantity<=0)throw new ToastApiError("invalid_response");
      lines.push({posItemId:s.item?.guid?"toast:"+restaurantGuid+":"+s.item.guid:null,
        name:s.displayName?.trim()||"Menu item",quantity:s.quantity,
        netSalesCents:s.voided?0:cents(s.price)-refunded,
        modifiers:(s.modifiers??[]).map(m=>({posModifierId:m.item?.guid??"",name:m.displayName??""})),
        voided:Boolean(s.voided),voidedBy:null,category:s.salesCategory?.name?.trim()||null});
    }
    for(const payment of c.payments) {
      tips+=cents(payment.tipAmount)-cents(payment.refund?.tipRefundAmount);
      // A payment refund without item-level refund details is ambiguous.
      if(payment.refundStatus&&payment.refundStatus!=="NONE"&&refunds===0)
        throw new ToastApiError("invalid_response");
    }
  }
  if(refunds>netBeforeRefunds||tips<0)throw new ToastApiError("invalid_response");
  return {posOrderId:"toast:"+restaurantGuid+":"+order.guid,posLocationId:restaurantGuid,
    posEmployeeId:order.server?.guid??order.openedBy?.guid??null,
    diningOption:order.diningOption?.name?.trim()||null,sourceChannel:order.source?.trim()||null,
    guestCount:order.numberOfGuests??null,
    closedAt:timestamp(order.closedDate),grossSalesCents:netBeforeRefunds+discounts,
    discountsCents:discounts,refundsCents:refunds,taxCents:tax,tipCents:tips,
    processingFeeStatus:"missing",processingFeeCents:0,
    netSalesCents:netBeforeRefunds-refunds,lines};
}
export type ToastLaborEmployeeSource={employeeGuid:string;restaurantGuid:string;
  sourceFields:z.infer<typeof employeeSourceSchema>};
export type ToastLaborJobSource={jobGuid:string;restaurantGuid:string;
  sourceFields:z.infer<typeof jobSourceSchema>};
export type ToastScheduledShift={externalShiftId:string;externalEmployeeId:string;externalLocationId:string;
  scheduledStart:string;scheduledEnd:string;externalJobId:string|null;deleted:boolean;sourceProvider:"toast";
  /** Source-shaped, whitelisted evidence for the POS0b consumer; not another store. */
  sourceFields?:z.infer<typeof shiftSourceSchema>};
export type ToastAttendanceFact={externalTimeEntryId:string;externalEmployeeId:string;
  externalLocationId:string;clockIn:string;clockOut:string|null;hourlyWageCents:number|null;
  providerRegularHours?:number|null;providerOvertimeHours?:number|null;
  breaks:PosTimecard["breaks"];deleted:boolean;modifiedAt?:string|null;sourceProvider:"toast";
  /** Optional to keep existing payroll mapping compatible until POS0b consumes it. */
  sourceFields?:z.infer<typeof timeEntrySourceSchema>};
export type ToastOrderState="completed"|"open"|"reopened"|"voided"|"deleted"|"refunded"|"ambiguous";
export type ToastOrderFact={orderGuid:string;restaurantGuid:string;modifiedAt:string;state:ToastOrderState;normalizedOrder:PosOrder|null};
export function classifyToastOrder(order:Order,restaurantGuid:string):ToastOrderFact {
 if(!order.modifiedDate)throw new ToastApiError("invalid_response");
 const modifiedAt=timestamp(order.modifiedDate);
 const complex=order.checks.some(c=>(c.appliedServiceCharges?.length??0)>0||
   c.selections.some(s=>s.voided));
 const refunded=order.checks.some(c=>c.selections.some(s=>(s.refundDetails?.refundAmount??0)>0)||
   c.payments.some(p=>p.refundStatus&&p.refundStatus!=="NONE"));
 const state:ToastOrderState=order.deleted?"deleted":order.voided?"voided":
   refunded?"refunded":complex||order.checks.length===0?"ambiguous":
   order.checks.some(c=>c.paymentStatus!=="CLOSED"||!c.closedDate)
    ?(order.closedDate?"reopened":"open"):
   !order.closedDate||order.createdInTestMode?"ambiguous":"completed";
 return {orderGuid:order.guid,restaurantGuid,modifiedAt,state,
   normalizedOrder:state==="completed"?normalizeToastOrder(order,restaurantGuid):null};
}
/** Parse untrusted Toast payloads consistently, including a valid empty checks array. */
export function parseToastOrderFact(payload:unknown,restaurantGuid:string):ToastOrderFact {
 const parsed=ordersSchema.element.safeParse(payload);
 if(!parsed.success)throw new ToastApiError("invalid_response");
 return classifyToastOrder(parsed.data,restaurantGuid);
}
export type ToastCatalogFact={kind:"item"|"modifier";provider_guid:string;name:string;
  category:string|null;price_cents:number|null;pricing_strategy:string|null;
  modifier_group_guids:string[]};
export type ToastEmployeeRosterFact={employee_guid:string;display_name:string;deleted:boolean};
export type ToastAdapter=PosAdapter&{
  fetchModifiedOrders(range:Range):Promise<PosOrder[]>;
  fetchBusinessDayOrders(day:string):Promise<PosOrder[]>;
  fetchOrderByGuid(orderGuid:string):Promise<PosOrder|null>;
  fetchOrderStateByGuid(orderGuid:string):Promise<ToastOrderFact>;
  fetchModifiedOrderStates(range:Range):Promise<ToastOrderFact[]>;
  fetchModifiedOrderStatesPage(range:Range,page:number):Promise<{facts:ToastOrderFact[];hasMore:boolean}>;
  fetchMenuMetadata():Promise<{restaurantGuid:string;lastUpdated:string}>;
  fetchCatalogFacts():Promise<ToastCatalogFact[]>;
  /** Receipt requires stable authenticated metadata before/after one full Menus V2 GET. */
  fetchPublishedCatalogBundle():Promise<{items:PosCatalogItem[];facts:ToastCatalogFact[];
    receipt:{restaurantGuid:string;publicationVersion:string;observedAt:string}}>;
  fetchEmployeeRosterFacts():Promise<ToastEmployeeRosterFact[]>;
  fetchLaborEmployeeSources():Promise<ToastLaborEmployeeSource[]>;
  fetchLaborJobSources():Promise<ToastLaborJobSource[]>;
  fetchScheduledShifts(range:Range):Promise<ToastScheduledShift[]>;
  fetchAttendanceFacts(range:Range):Promise<ToastAttendanceFact[]>;
  fetchAttendanceChanges(range:Range):Promise<ToastAttendanceFact[]>;
};
/** Read-only adapter. DO NOT use its modified-order scan as proof of closed-date coverage.
 * Automatic canonical import stays disabled until CSV overlap/reconciliation is solved. */
export function createToastAdapter(params?:{db:SupabaseClient;businessId:string;restaurantGuid:string;deadlineAt?:number}):ToastAdapter {
  if(!params)throw new PosNotConnectedError("toast");
  const {db,businessId,restaurantGuid}=params;
  if(!GUID.safeParse(restaurantGuid).success)throw new ToastApiError("unauthorized_location");
  const client=createToastClient(db,businessId);
  const request=<T>(path:string,schema:z.ZodType<T>)=>client.request(path,restaurantGuid,schema,{deadlineAt:params.deadlineAt});
  /** A partial published menu has no authority to remove prior provider items.
   * Toast can return a success response with missing referenced options; never
   * silently filter those references into a seemingly complete snapshot. */
  async function fetchValidatedPublishedMenu() {
    const data=await request("/menus/v2/menus",menusSchema);
    if(data.restaurantGuid.toLowerCase()!==restaurantGuid.toLowerCase())
      throw new ToastApiError("unauthorized_location");
    const groups=data.modifierGroupReferences;
    const options=data.modifierOptionReferences;
    let itemCount=0;
    for(const group of Object.values(groups)) {
      if(!Array.isArray(group.modifierOptionReferences))
        throw new ToastApiError("invalid_response");
      for(const ref of group.modifierOptionReferences)
        if(!options[String(ref)])throw new ToastApiError("invalid_response");
    }
    const verifyGroup=(group:MenuGroup):void=>{
      if(!Array.isArray(group.menuItems)||!Array.isArray(group.menuGroups))
        throw new ToastApiError("invalid_response");
      for(const item of group.menuItems) {
        itemCount++;
        for(const ref of item.modifierGroupReferences??[])
          if(!groups[String(ref)])throw new ToastApiError("invalid_response");
        if(item.pricingStrategy==="SIZE_PRICE") {
          const guid=item.pricingRules?.sizeSpecificPricingGuid;
          const sizeGroup=Object.values(groups).find(g=>g.guid===guid);
          if(!sizeGroup||!sizeGroup.modifierOptionReferences.length)
            throw new ToastApiError("invalid_response");
        }
      }
      for(const child of group.menuGroups)verifyGroup(child);
    };
    for(const menu of data.menus){
      if(!Array.isArray(menu.menuGroups))throw new ToastApiError("invalid_response");
      for(const group of menu.menuGroups)verifyGroup(group);
    }
    // No-items may be legitimate upstream, but it cannot certify unpublication.
    if(!itemCount)throw new ToastApiError("invalid_response");
    return data;
  }
  async function statePage(range:Range,page:number):Promise<{facts:ToastOrderFact[];hasMore:boolean}> {
    if(!Number.isSafeInteger(page)||page<1||page>1000)throw new ToastApiError("invalid_response");
    const search=query(range);
    const rows=await request("/orders/v2/ordersBulk?"+search+"&pageSize=100&page="+page,ordersSchema);
    // One page per invocation. The final short/empty page is authoritative only for
    // this complete modified-time window; never infer a verified zero-sales day.
    return {facts:rows.map(row=>classifyToastOrder(row,restaurantGuid)),hasMore:rows.length===100};
  }
  async function allStateOrders(search:string):Promise<ToastOrderFact[]> {
    const found=new Map<string,ToastOrderFact>();
    for(let page=1;page<=20;page++){
      const rows=await request("/orders/v2/ordersBulk?"+search+"&pageSize=100&page="+page,ordersSchema);
      for(const row of rows){
        const fact=classifyToastOrder(row,restaurantGuid);
        const prior=found.get(fact.orderGuid);
        if(!prior||prior.modifiedAt<=fact.modifiedAt)found.set(fact.orderGuid,fact);
      }
      if(rows.length<100)return [...found.values()];
    }
    throw new ToastApiError("invalid_response");
  }
  async function allOrders(query:string):Promise<PosOrder[]> {
    const result=new Map<string,PosOrder>();
    for(let page=1;page<=20;page++) {
      const rows=await request("/orders/v2/ordersBulk?"+query+"&pageSize=100&page="+page,ordersSchema);
      for(const row of rows) {
        const normalized=normalizeToastOrder(row,restaurantGuid);
        if(normalized)result.set(normalized.posOrderId,normalized);
      }
      if(rows.length<100)return [...result.values()];
    }
    // More than 2,000 orders requires resumable pagination, not an unbounded Vercel request.
    throw new ToastApiError("invalid_response"); // No partial success.
  }
  const query=(range:Range)=>{
    validRange(range);
    return "startDate="+toToastTimestamp(range.since)+
      "&endDate="+toToastTimestamp(range.until);
  };
  async function fetchAttendance(range:Range,mode:"historical"|"modified"):Promise<ToastAttendanceFact[]> {
    const params=mode==="modified"
      ?query(range).replace("startDate=","modifiedStartDate=").replace("&endDate=","&modifiedEndDate=")
      :query(range)+"&includeArchived=true";
    const rows=await request("/labor/v1/timeEntries?"+params,timeEntriesSchema);
    if(mode==="modified"&&rows.some(r=>!r.modifiedDate))
      throw new ToastApiError("invalid_response");
    return rows.map(r=>({
      externalTimeEntryId:r.guid,externalEmployeeId:r.employeeReference.guid,
      externalLocationId:restaurantGuid,modifiedAt:r.modifiedDate?timestamp(r.modifiedDate):null,
      clockIn:timestamp(r.inDate),clockOut:r.outDate?timestamp(r.outDate):null,
      hourlyWageCents:r.hourlyWage==null?null:cents(r.hourlyWage),
      providerRegularHours:r.regularHours??null,providerOvertimeHours:r.overtimeHours??null,
      deleted:Boolean(r.deleted),sourceProvider:"toast" as const,
      sourceFields:validatedLaborSource(timeEntrySourceSchema,r),
      breaks:(r.breaks??[]).filter(b=>b.missed===false&&b.inDate&&b.outDate)
        .map(b=>({start:timestamp(b.inDate!),end:timestamp(b.outDate!),paid:b.paid===true}))
    }));
  }
  function catalogItemsFromSnapshot(data:z.infer<typeof menusSchema>):PosCatalogItem[] {
      const items=new Map<string,PosCatalogItem>();
      // One canonical item/size key cannot assert two different published prices.
      // Toast may repeat a GUID across menu contexts; retain a stable first
      // representation only when price, strategy and provider identity agree.
      // A conflicting price needs explicit context modeling before a sync can
      // replace the last-known published price or start price-change monitoring.
      const addPublished=(item:PosCatalogItem)=>{
        const prior=items.get(item.posItemId);
        if(prior){
          if(prior.priceCents!==item.priceCents||
            prior.pricingStrategy!==item.pricingStrategy||
            prior.name!==item.name||prior.sizeLabel!==item.sizeLabel)
            throw new ToastApiError("invalid_response");
          return;
        }
        items.set(item.posItemId,item);
      };
      const groups=Object.values(data.modifierGroupReferences);
      const options=data.modifierOptionReferences;
      const posId=(guid:string)=>"toast:"+restaurantGuid+":"+guid;
      // Toast Menus v2 supplies basePrice inside time-specific rules.
      // Use only a consistent base, never invent an unresolved price.
      const resolvedRulePrice=(strategy:string|null|undefined,price:number|null|undefined,
        rules:z.infer<typeof pricingRulesSchema>|null|undefined):number|null=>{
        if(strategy==="OPEN_PRICE")return null;
        if(price!=null&&["BASE_PRICE","MENU_SPECIFIC_PRICE","GROUP_PRICE","TIME_SPECIFIC_PRICE"]
          .includes(strategy??""))return cents(price);
        if(strategy==="TIME_SPECIFIC_PRICE"){
          const bases=(rules?.timeSpecificPricingRules??[])
            .map(rule=>rule.basePrice).filter((value):value is number=>value!=null);
          if(bases.length&&bases.every(base=>base===bases[0]))return cents(bases[0]);
        }
        return null;
      };
      function visit(g:MenuGroup,path:string[],menuAvailability:unknown){
        for(const i of g.menuItems) {
          const itemGroups=(i.modifierGroupReferences??[])
            .map(id=>data.modifierGroupReferences[String(id)]).filter((x):x is typeof groups[number]=>Boolean(x));
          const linkedGroups=itemGroups.map(group=>({
            posGroupId:posId(group.guid),name:group.name??"Modifier group",
            minSelections:group.minSelections??null,maxSelections:group.maxSelections??null,
            required:group.requiredMode==="REQUIRED",
            posMetadata:group as Record<string,unknown>,
            options:group.modifierOptionReferences.map(id=>options[String(id)]).filter((o):o is NonNullable<typeof options[string]>=>Boolean(o)).map(o=>({
              posModifierId:posId(o.guid),name:o.name,
              priceCents:resolvedRulePrice(o.pricingStrategy??"NONE",o.price,o.pricingRules),
              pricingStrategy:o.pricingStrategy??null,posMetadata:o as Record<string,unknown>
            }))
          }));
          const resolvedPrice=resolvedRulePrice(i.pricingStrategy,i.price,i.pricingRules);
          const visibility=(i.visibility??[]).filter((v):v is string=>typeof v==="string").join(",")||null;
          const common={
            name:i.name,baseName:i.name,category:i.salesCategory?.name??g.name,
            menuGroup:path.join(" / "),description:i.description??null,
            visibility,pricingStrategy:i.pricingStrategy??null,
            imageUrl:i.image??null,plu:i.plu??null,sku:i.sku??null,
            modifierGroups:linkedGroups,
            posMetadata:{
              itemGuid:i.guid,pricingRules:i.pricingRules??null,
              itemVisibility:i.visibility??null,
              menuAvailability,groupAvailability:g.availability??null,
              originalItem:i,originalModifierGroups:itemGroups,
              originalModifierOptions:itemGroups.flatMap(group=>group.modifierOptionReferences
                .map(ref=>options[String(ref)]).filter(Boolean))
            } as Record<string,unknown>
          };
          const sizeGuid=i.pricingStrategy==="SIZE_PRICE"?i.pricingRules?.sizeSpecificPricingGuid:null;
          const sizeGroup=sizeGuid?groups.find(group=>group.guid===sizeGuid):undefined;
          const sizes=(sizeGroup?.modifierOptionReferences??[])
            .map(id=>options[String(id)]).filter((o):o is NonNullable<typeof options[string]>=>Boolean(o));
          if(sizes.length){
            for(const option of sizes){
              const id=posId(i.guid)+":size:"+option.guid;
              // Toast publishes size prices on the Size group's option items.
              const sizePrice=resolvedRulePrice(option.pricingStrategy??"NONE",option.price,option.pricingRules);
              addPublished({...common,posItemId:id,sizeLabel:option.name,priceCents:sizePrice,
                posMetadata:{...common.posMetadata,sizeOption:option}});
            }
          }else{
            const id=posId(i.guid);
            addPublished({...common,posItemId:id,sizeLabel:null,priceCents:resolvedPrice});
          }
        }
        for(const child of g.menuGroups)visit(child,[...path,child.name],menuAvailability);
      }
      for(const menu of data.menus)for(const group of menu.menuGroups)
        visit(group,[menu.name??"Menu",group.name],menu.availability??null);
      if(items.size>5000)throw new ToastApiError("invalid_response");
      return [...items.values()];
  }

  function catalogFactsFromSnapshot(data:z.infer<typeof menusSchema>):ToastCatalogFact[] {
      const seen=new Map<string,ToastCatalogFact>();
      const groups=data.modifierGroupReferences;
      const options=data.modifierOptionReferences;
      function add(group:MenuGroup){
        for(const item of group.menuItems){
          const referenced=(item.modifierGroupReferences??[]).map(id=>groups[String(id)]?.guid)
            .filter((guid):guid is string=>Boolean(guid));
          const knownPrice=item.price==null?null:(
            item.pricingStrategy==="BASE_PRICE"||item.pricingStrategy==="MENU_SPECIFIC_PRICE")
            ?cents(item.price):null;
          const fact:ToastCatalogFact={kind:"item",provider_guid:item.guid,
            name:item.name,category:item.salesCategory?.name??group.name,
            price_cents:knownPrice,pricing_strategy:item.pricingStrategy??null,
            modifier_group_guids:referenced};
          const prior=seen.get("item:"+item.guid);
          if(prior&&prior.price_cents!==fact.price_cents)
            fact.price_cents=null; // Variable menu-specific pricing needs review.
          seen.set("item:"+item.guid,fact);
        }
        for(const next of group.menuGroups)add(next);
      }
      for(const menu of data.menus)for(const group of menu.menuGroups)add(group);
      for(const option of Object.values(options)){
        const knownPrice=option.price!=null&&(option.pricingStrategy==="BASE_PRICE"||
          option.pricingStrategy==="MENU_SPECIFIC_PRICE")
          ?cents(option.price):null;
        seen.set("modifier:"+option.guid,{kind:"modifier",provider_guid:option.guid,
          name:option.name,category:null,price_cents:knownPrice,
          pricing_strategy:option.pricingStrategy??null,modifier_group_guids:[]});
      }
      if(seen.size>5000)throw new ToastApiError("invalid_response");
      return [...seen.values()];
  }

  const result:ToastAdapter={
    provider:"toast",
    fetchModifiedOrders:(range)=>allOrders(query(range)),
    fetchModifiedOrderStates:(range)=>allStateOrders(query(range)),
    fetchModifiedOrderStatesPage:statePage,
    fetchBusinessDayOrders:(day)=>{
      if(!/^\d{8}$/.test(day))throw new ToastApiError("invalid_response");
      return allOrders("businessDate="+day);
    },
    async fetchOrderStateByGuid(orderGuid) {
      if(!GUID.safeParse(orderGuid).success)throw new ToastApiError("invalid_response");
      const row=await request("/orders/v2/orders/"+orderGuid,ordersSchema.element);
      if(row.guid.toLowerCase()!==orderGuid.toLowerCase())throw new ToastApiError("invalid_response");
      return classifyToastOrder(row,restaurantGuid);
    },
    async fetchOrderByGuid(orderGuid) {
      return (await result.fetchOrderStateByGuid(orderGuid)).normalizedOrder;
    },
    // Incremental changes only, never verified-zero coverage.
    fetchOrders:(range)=>allOrders(query(range)),
    async fetchMenuMetadata(){
      const metadata=await request("/menus/v2/metadata",metadataSchema);
      if(metadata.restaurantGuid.toLowerCase()!==restaurantGuid.toLowerCase())
        throw new ToastApiError("unauthorized_location");
      return metadata;
    },
    fetchCatalogItems:async()=>catalogItemsFromSnapshot(await fetchValidatedPublishedMenu()),
    fetchCatalogFacts:async()=>catalogFactsFromSnapshot(await fetchValidatedPublishedMenu()),
    async fetchPublishedCatalogBundle(){
      // Observe publication metadata on both sides of the SINGLE full Menus V2
      // request. A changed version, wrong location or incomplete reference set
      // is never authority to deactivate last-good provider state.
      const before=await request("/menus/v2/metadata",metadataSchema);
      if(before.restaurantGuid.toLowerCase()!==restaurantGuid.toLowerCase())
        throw new ToastApiError("unauthorized_location");
      const snapshot=await fetchValidatedPublishedMenu();
      const after=await request("/menus/v2/metadata",metadataSchema);
      if(after.restaurantGuid.toLowerCase()!==restaurantGuid.toLowerCase())
        throw new ToastApiError("unauthorized_location");
      if(before.lastUpdated!==after.lastUpdated)
        throw new ToastApiError("invalid_response");
      // Source metadata's lastUpdated is the publication version/last-modified
      // reference, NOT a verified historical effective time.
      timestamp(after.lastUpdated); // Valid date, but preserve Toast's exact version string.
      const publicationVersion=after.lastUpdated;
      const items=catalogItemsFromSnapshot(snapshot);
      const facts=catalogFactsFromSnapshot(snapshot);
      return {items,facts,receipt:{restaurantGuid,publicationVersion,
        observedAt:new Date().toISOString()}};
    },
    async fetchEmployeeRosterFacts():Promise<ToastEmployeeRosterFact[]> {
      const rows=await request("/labor/v1/employees",employeesSchema);
      return rows.map(r=>({
        employee_guid:r.guid,
        display_name:([r.chosenName||r.firstName,r.lastName].filter(Boolean).join(" ").trim()||
          "Toast employee "+r.guid.slice(0,8)),
        deleted:Boolean(r.deleted)
      }));
    },
    async fetchLaborEmployeeSources():Promise<ToastLaborEmployeeSource[]> {
      const rows=await request("/labor/v1/employees",employeesSchema);
      return rows.map(r=>({employeeGuid:r.guid,restaurantGuid,
        sourceFields:validatedLaborSource(employeeSourceSchema,r)}));
    },
    async fetchLaborJobSources():Promise<ToastLaborJobSource[]> {
      const rows=await request("/labor/v1/jobs",toastJobSchema);
      return rows.map(r=>({jobGuid:r.guid,restaurantGuid,
        sourceFields:validatedLaborSource(jobSourceSchema,r)}));
    },
    async fetchEmployees():Promise<PosEmployee[]> {
      const [rows,jobs]=await Promise.all([
        request("/labor/v1/employees",employeesSchema),
        request("/labor/v1/jobs",toastJobSchema)
      ]);
      const jobsById=new Map(jobs.filter(j=>!j.deleted).map(j=>[j.guid,j]));
      return rows.map(r=>{
        const displayName=[r.chosenName||r.firstName,r.lastName].filter(Boolean).join(" ").trim()
          ||"Toast employee "+r.guid.slice(0,8);
        const jobId=r.jobReferences?.find(j=>jobsById.has(j.guid))?.guid;
        const job=jobId?jobsById.get(jobId):undefined;
        const override=r.wageOverrides?.find(w=>w.jobReference.guid===jobId);
        const wage=override?.wage??(job?.wageFrequency==="HOURLY"?job.defaultWage:null);
        return {posTeamMemberId:"toast:"+restaurantGuid+":"+r.guid,
          displayName,posName:displayName,role:job?.title??null,
          hourlyWageCents:wage==null?null:cents(wage),active:!r.deleted};
      });
    },
    fetchAttendanceFacts:(range)=>fetchAttendance(range,"historical"),
    fetchAttendanceChanges:(range)=>fetchAttendance(range,"modified"),
    async fetchTimecards(range):Promise<PosTimecard[]> {
      const rows=await result.fetchAttendanceFacts(range);
      return rows.filter(r=>!r.deleted).map(r=>{
        if(r.hourlyWageCents==null)throw new ToastApiError("invalid_response");
        return {posTimecardId:"toast:"+restaurantGuid+":"+r.externalTimeEntryId,
          posTeamMemberId:"toast:"+restaurantGuid+":"+r.externalEmployeeId,
          clockIn:r.clockIn,clockOut:r.clockOut,hourlyWageCents:r.hourlyWageCents,
          breaks:r.breaks};
      });
    },
    async fetchScheduledShifts(range):Promise<ToastScheduledShift[]> {
      const rows=await request("/labor/v1/shifts?"+query(range),shiftsSchema);
      return rows.map(r=>({externalShiftId:r.guid,
        externalEmployeeId:r.employeeReference.guid,externalLocationId:restaurantGuid,
        scheduledStart:timestamp(r.inDate),scheduledEnd:timestamp(r.outDate),
        externalJobId:r.jobReference?.guid??null,deleted:Boolean(r.deleted),
        sourceProvider:"toast",sourceFields:validatedLaborSource(shiftSourceSchema,r)}));
    }
  };
  return result;
}
