import "server-only";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {PosAdapter,PosOrder,PosCatalogItem,PosEmployee,PosTimecard} from "../types";
import {PosNotConnectedError} from "../types";
import {createToastClient,GUID,ToastApiError} from "./client";
type Range={since:Date;until:Date};
type Discount={nonTaxDiscountAmount?:number|null};
type Selection={displayName?:string|null;item?:{guid:string}|null;quantity:number;price:number;
  voided?:boolean|null;modifiers?:{displayName?:string|null;item?:{guid:string}|null}[]|null;
  refundDetails?:{refundAmount?:number|null}|null;appliedDiscounts?:Discount[]|null};
type Check={amount:number;taxAmount:number;paymentStatus:string;closedDate?:string|null;
  appliedDiscounts?:Discount[]|null;selections:Selection[];
  payments:{tipAmount?:number|null;refundStatus?:string|null;
    refund?:{refundAmount?:number|null;tipRefundAmount?:number|null}|null}[]};
type Order={guid:string;closedDate?:string|null;createdInTestMode?:boolean|null;
  deleted?:boolean|null;checks:Check[]};
const discount=z.object({nonTaxDiscountAmount:z.number().nullish()});
const selection=z.object({displayName:z.string().nullish(),item:z.object({guid:GUID}).nullish(),
  quantity:z.number(),price:z.number(),voided:z.boolean().nullish(),
  modifiers:z.array(z.object({displayName:z.string().nullish(),item:z.object({guid:GUID}).nullish()})).nullish(),
  refundDetails:z.object({refundAmount:z.number().nullish()}).nullish(),
  appliedDiscounts:z.array(discount).nullish()});
const check=z.object({amount:z.number(),taxAmount:z.number(),paymentStatus:z.string(),
  closedDate:z.string().nullish(),appliedDiscounts:z.array(discount).nullish(),
  selections:z.array(selection),payments:z.array(z.object({
    tipAmount:z.number().nullish(),refundStatus:z.string().nullish(),
    refund:z.object({refundAmount:z.number().nullish(),tipRefundAmount:z.number().nullish()}).nullish()}))});
const ordersSchema=z.array(z.object({guid:GUID,closedDate:z.string().nullish(),
  createdInTestMode:z.boolean().nullish(),deleted:z.boolean().nullish(),
  checks:z.array(check).min(1)}));
const employeesSchema=z.array(z.object({guid:GUID,firstName:z.string().nullish(),
  chosenName:z.string().nullish(),lastName:z.string().nullish(),deleted:z.boolean().nullish()}));
const timeEntriesSchema=z.array(z.object({guid:GUID,employeeReference:z.object({guid:GUID}),
  inDate:z.string(),outDate:z.string().nullish(),hourlyWage:z.number().nullish(),
  deleted:z.boolean().nullish(),breaks:z.array(z.object({
    inDate:z.string().nullish(),outDate:z.string().nullish(),
    paid:z.boolean().nullish(),missed:z.boolean().nullish()})).nullish()}));
const shiftsSchema=z.array(z.object({guid:GUID,employeeReference:z.object({guid:GUID}),
  jobReference:z.object({guid:GUID}).nullish(),inDate:z.string(),outDate:z.string(),
  deleted:z.boolean().nullish()}));
const itemSchema=z.object({guid:GUID,name:z.string().min(1),price:z.number().nullish(),
  pricingStrategy:z.string().nullish(),salesCategory:z.object({name:z.string()}).nullish()});
type MenuGroup={name:string;menuItems:z.infer<typeof itemSchema>[];menuGroups:MenuGroup[]};
const groupSchema:z.ZodType<MenuGroup>=z.lazy(()=>z.object({
  name:z.string(),menuItems:z.array(itemSchema).default([]),menuGroups:z.array(groupSchema).default([])}));
const menusSchema=z.object({restaurantGuid:GUID,menus:z.array(
  z.object({menuGroups:z.array(groupSchema).default([])}))});
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
  if(order.createdInTestMode||order.deleted)return null;
  if(order.checks.some(c=>c.paymentStatus!=="CLOSED"||!c.closedDate))return null;
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
        voided:Boolean(s.voided),voidedBy:null});
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
    closedAt:timestamp(order.closedDate),grossSalesCents:netBeforeRefunds+discounts,
    discountsCents:discounts,refundsCents:refunds,taxCents:tax,tipCents:tips,
    processingFeeStatus:"missing",processingFeeCents:0,
    netSalesCents:netBeforeRefunds-refunds,lines};
}
export type ToastScheduledShift={externalShiftId:string;externalEmployeeId:string;externalLocationId:string;
  scheduledStart:string;scheduledEnd:string;externalJobId:string|null;deleted:boolean;sourceProvider:"toast"};
export type ToastAttendanceFact={externalTimeEntryId:string;externalEmployeeId:string;
  externalLocationId:string;clockIn:string;clockOut:string|null;hourlyWageCents:number|null;
  breaks:PosTimecard["breaks"];deleted:boolean;sourceProvider:"toast"};
export type ToastAdapter=PosAdapter&{
  fetchModifiedOrders(range:Range):Promise<PosOrder[]>;
  fetchBusinessDayOrders(day:string):Promise<PosOrder[]>;
  fetchOrderByGuid(orderGuid:string):Promise<PosOrder|null>;
  fetchMenuMetadata():Promise<{restaurantGuid:string;lastUpdated:string}>;
  fetchScheduledShifts(range:Range):Promise<ToastScheduledShift[]>;
  fetchAttendanceFacts(range:Range):Promise<ToastAttendanceFact[]>;
};
/** Read-only adapter. DO NOT use its modified-order scan as proof of closed-date coverage.
 * Automatic canonical import stays disabled until CSV overlap/reconciliation is solved. */
export function createToastAdapter(params?:{db:SupabaseClient;businessId:string;restaurantGuid:string}):ToastAdapter {
  if(!params)throw new PosNotConnectedError("toast");
  const {db,businessId,restaurantGuid}=params;
  if(!GUID.safeParse(restaurantGuid).success)throw new ToastApiError("unauthorized_location");
  const client=createToastClient(db,businessId);
  const request=<T>(path:string,schema:z.ZodType<T>)=>client.request(path,restaurantGuid,schema);
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
  const result:ToastAdapter={
    provider:"toast",
    fetchModifiedOrders:(range)=>allOrders(query(range)),
    fetchBusinessDayOrders:(day)=>{
      if(!/^\d{8}$/.test(day))throw new ToastApiError("invalid_response");
      return allOrders("businessDate="+day);
    },
    async fetchOrderByGuid(orderGuid) {
      if(!GUID.safeParse(orderGuid).success)throw new ToastApiError("invalid_response");
      const row=await request("/orders/v2/orders/"+orderGuid,ordersSchema.element);
      if(row.guid.toLowerCase()!==orderGuid.toLowerCase())throw new ToastApiError("invalid_response");
      return normalizeToastOrder(row,restaurantGuid);
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
    async fetchEmployees():Promise<PosEmployee[]> {
      const rows=await request("/labor/v1/employees",employeesSchema);
      return rows.filter(r=>!r.deleted).map(r=>{
        const displayName=[r.chosenName||r.firstName,r.lastName].filter(Boolean).join(" ").trim();
        if(!displayName)throw new ToastApiError("invalid_response");
        return {posTeamMemberId:"toast:"+restaurantGuid+":"+r.guid,displayName,role:null};
      });
    },
    async fetchAttendanceFacts(range):Promise<ToastAttendanceFact[]> {
      const rows=await request("/labor/v1/timeEntries?"+query(range),timeEntriesSchema);
      return rows.map(r=>({
        externalTimeEntryId:r.guid,externalEmployeeId:r.employeeReference.guid,
        externalLocationId:restaurantGuid,clockIn:timestamp(r.inDate),
        clockOut:r.outDate?timestamp(r.outDate):null,
        hourlyWageCents:r.hourlyWage==null?null:cents(r.hourlyWage),
        deleted:Boolean(r.deleted),sourceProvider:"toast" as const,
        breaks:(r.breaks??[]).filter(b=>b.missed===false&&b.inDate&&b.outDate)
          .map(b=>({start:timestamp(b.inDate!),end:timestamp(b.outDate!),paid:b.paid===true})),
      }));
    },
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
