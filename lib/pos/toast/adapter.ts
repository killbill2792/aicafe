import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PosAdapter,PosOrder,PosCatalogItem,PosEmployee,PosTimecard} from "../types";
import {PosNotConnectedError} from "../types";
import {createToastClient,GUID,ToastApiError} from "./client";
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
const employeesSchema=z.array(z.object({guid:GUID,firstName:z.string().nullish(),
  chosenName:z.string().nullish(),lastName:z.string().nullish(),deleted:z.boolean().nullish()}));
const timeEntriesSchema=z.array(z.object({guid:GUID,modifiedDate:z.string().nullish(),employeeReference:z.object({guid:GUID}),
  inDate:z.string(),outDate:z.string().nullish(),hourlyWage:z.number().nullish(),
  deleted:z.boolean().nullish(),breaks:z.array(z.object({
    inDate:z.string().nullish(),outDate:z.string().nullish(),
    paid:z.boolean().nullish(),missed:z.boolean().nullish()})).nullish()}));
const shiftsSchema=z.array(z.object({guid:GUID,employeeReference:z.object({guid:GUID}),
  jobReference:z.object({guid:GUID}).nullish(),inDate:z.string(),outDate:z.string(),
  deleted:z.boolean().nullish()}));
const itemSchema=z.object({guid:GUID,name:z.string().min(1),price:z.number().nullish(),
  pricingStrategy:z.string().nullish(),salesCategory:z.object({name:z.string().nullish()}).nullish(),
  modifierGroupReferences:z.array(z.number()).nullish()});
type MenuGroup={name:string;menuItems:z.infer<typeof itemSchema>[];menuGroups:MenuGroup[]};
const groupSchema:z.ZodType<MenuGroup>=z.lazy(()=>z.object({
  name:z.string(),menuItems:z.array(itemSchema).default([]),menuGroups:z.array(groupSchema).default([])}));
const menusSchema=z.object({restaurantGuid:GUID,menus:z.array(
  z.object({menuGroups:z.array(groupSchema).default([])})),
  modifierGroupReferences:z.record(z.string(),z.object({
    guid:GUID,modifierOptionReferences:z.array(z.number()).default([])
  })).default({}),
  modifierOptionReferences:z.record(z.string(),z.object({
    guid:GUID,name:z.string().min(1),price:z.number().nullish(),
    pricingStrategy:z.string().nullish()
  })).default({})
});
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
  const cents=Math.round(value*100);
  if(!Number.isSafeInteger(cents)||Math.abs(value*100-cents)>1e-7)
    throw new ToastApiError("invalid_response");
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
export type ToastScheduledShift={externalShiftId:string;externalEmployeeId:string;externalLocationId:string;
  scheduledStart:string;scheduledEnd:string;externalJobId:string|null;deleted:boolean;sourceProvider:"toast"};
export type ToastAttendanceFact={externalTimeEntryId:string;externalEmployeeId:string;
  externalLocationId:string;clockIn:string;clockOut:string|null;hourlyWageCents:number|null;
  breaks:PosTimecard["breaks"];deleted:boolean;modifiedAt?:string|null;sourceProvider:"toast"};
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
  fetchEmployeeRosterFacts():Promise<ToastEmployeeRosterFact[]>;
  fetchScheduledShifts(range:Range):Promise<ToastScheduledShift[]>;
  fetchAttendanceFacts(range:Range):Promise<ToastAttendanceFact[]>;
  fetchAttendanceChanges(range:Range):Promise<ToastAttendanceFact[]>;
};
/** Read-only adapter. DO NOT use its modified-order scan as proof of closed-date coverage.
 * Automatic canonical import stays disabled until CSV overlap/reconciliation is solved. */
export function createToastAdapter(params?:{db:SupabaseClient;businessId:string;restaurantGuid:string}):ToastAdapter {
  if(!params)throw new PosNotConnectedError("toast");
  const {db,businessId,restaurantGuid}=params;
  if(!GUID.safeParse(restaurantGuid).success)throw new ToastApiError("unauthorized_location");
  const client=createToastClient(db,businessId);
  const request=<T>(path:string,schema:z.ZodType<T>)=>client.request(path,restaurantGuid,schema);
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
    return "startDate="+encodeURIComponent(range.since.toISOString())+
      "&endDate="+encodeURIComponent(range.until.toISOString());
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
      deleted:Boolean(r.deleted),sourceProvider:"toast" as const,
      breaks:(r.breaks??[]).filter(b=>b.missed===false&&b.inDate&&b.outDate)
        .map(b=>({start:timestamp(b.inDate!),end:timestamp(b.outDate!),paid:b.paid===true}))
    }));
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
    fetchMenuMetadata:()=>request("/menus/v2/metadata",metadataSchema),
    async fetchCatalogItems():Promise<PosCatalogItem[]> {
      const data=await request("/menus/v2/menus",menusSchema);
      if(data.restaurantGuid.toLowerCase()!==restaurantGuid.toLowerCase())
        throw new ToastApiError("unauthorized_location");
      const items=new Map<string,PosCatalogItem>();
      function visit(g:MenuGroup) {
        for(const i of g.menuItems) {
          const simple=i.pricingStrategy==="BASE_PRICE"||i.pricingStrategy==="MENU_SPECIFIC_PRICE";
          items.set(i.guid,{posItemId:"toast:"+restaurantGuid+":"+i.guid,name:i.name,
            priceCents:simple&&i.price!=null?cents(i.price):null,
            category:i.salesCategory?.name??g.name});
        }
        for(const child of g.menuGroups)visit(child);
      }
      for(const menu of data.menus)for(const group of menu.menuGroups)visit(group);
      return [...items.values()];
    },
    async fetchCatalogFacts():Promise<ToastCatalogFact[]> {
      const data=await request("/menus/v2/menus",menusSchema);
      if(data.restaurantGuid.toLowerCase()!==restaurantGuid.toLowerCase())
        throw new ToastApiError("unauthorized_location");
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
    async fetchEmployees():Promise<PosEmployee[]> {
      const rows=await request("/labor/v1/employees",employeesSchema);
      return rows.filter(r=>!r.deleted).map(r=>{
        const displayName=[r.chosenName||r.firstName,r.lastName].filter(Boolean).join(" ").trim();
        if(!displayName)throw new ToastApiError("invalid_response");
        return {posTeamMemberId:"toast:"+restaurantGuid+":"+r.guid,displayName,role:null};
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
        externalJobId:r.jobReference?.guid??null,deleted:Boolean(r.deleted),sourceProvider:"toast"}));
    }
  };
  return result;
}
