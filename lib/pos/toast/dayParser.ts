import {createHash} from "node:crypto";
import {z} from "zod";
import {formatInTimeZone} from "date-fns-tz";
import type {PosOrder} from "../types";
import {GUID,ToastApiError} from "./client";

const money=z.number().finite().nullish();
const reference=z.object({guid:GUID}).passthrough().nullish();
const discount=z.object({discountAmount:money,nonTaxDiscountAmount:money}).passthrough();
const selection=z.object({
  guid:GUID.optional(),displayName:z.string().nullish(),item:reference,
  salesCategory:z.object({name:z.string().nullish()}).passthrough().nullish(),
  quantity:money,price:money,preDiscountPrice:money,receiptLinePrice:money,tax:money,
  taxInclusion:z.string().nullish(),selectionType:z.string().nullish(),
  deferred:z.boolean().nullish(),voided:z.boolean().nullish(),
  voidBusinessDate:z.number().int().nullish(),voidDate:z.string().nullish(),voidReason:reference,
  modifiers:z.array(z.object({displayName:z.string().nullish(),item:reference}).passthrough()).nullish(),
  refundDetails:z.object({refundAmount:money}).passthrough().nullish(),
  appliedDiscounts:z.array(discount).nullish(),
}).passthrough();
const payment=z.object({
  guid:GUID.optional(),paymentStatus:z.string().nullish(),tipAmount:money,
  refund:z.object({refundAmount:money,tipRefundAmount:money,refundBusinessDate:z.number().int().nullish()}).passthrough().nullish(),
  voidInfo:z.object({voidBusinessDate:z.number().int().nullish()}).passthrough().nullish(),
}).passthrough();
const check=z.object({
  guid:GUID.optional(),amount:money,taxAmount:money,paymentStatus:z.string().nullish(),
  voided:z.boolean().nullish(),deleted:z.boolean().nullish(),
  voidBusinessDate:z.number().int().nullish(),voidDate:z.string().nullish(),
  selections:z.array(selection).nullish(),payments:z.array(payment).nullish(),
  appliedDiscounts:z.array(discount).nullish(),
  appliedServiceCharges:z.array(z.object({
    chargeAmount:money,gratuity:z.boolean().nullish(),serviceChargeCategory:z.string().nullish()
  }).passthrough()).nullish(),
}).passthrough();
const order=z.object({
  guid:GUID,businessDate:z.number().int().nullish(),openedDate:z.string().nullish(),
  closedDate:z.string().nullish(),modifiedDate:z.string().nullish(),
  voided:z.boolean().nullish(),deleted:z.boolean().nullish(),
  excessFood:z.boolean().nullish(),createdInTestMode:z.boolean().nullish(),
  voidBusinessDate:z.number().int().nullish(),voidDate:z.string().nullish(),
  server:reference,openedBy:reference,diningOption:z.object({name:z.string().nullish()}).passthrough().nullish(),
  source:z.string().nullish(),numberOfGuests:z.number().int().nonnegative().nullish(),
  checks:z.array(check).nullish(),
}).passthrough();

export type ToastVoidFact={
  selection_guid:string;order_guid:string;check_guid:string|null;
  order_business_date:string;void_business_date:string;
  voided_at:string|null;amount_cents:number|null;amount_basis:string|null;
  void_reason_guid:string|null;level:"selection"|"check"|"order";
};
export type ToastRefundFact={payment_guid:string|null;refund_business_date:string|null;amount_cents:number};
export type DayOrder={
  guid:string;modifiedAt:string;businessDate:string;
  normalized:PosOrder|null;openCheckCount:number;
  serviceChargesCents:number;gratuityCents:number;
  voids:ToastVoidFact[];refundFacts:ToastRefundFact[];
  warnings:Record<string,number>;
};
export type DayParseResult={orders:DayOrder[];unparsed:Array<{
  order_guid:string|null;business_date:string;error_path:string;raw_sha256:string
}>;warnings:Record<string,number>};

/** Toast decimal dollars are converted once; ties round away from zero. */
export function toastMoneyCents(value:number,onWarning?:(key:string)=>void):number {
  if(!Number.isFinite(value))throw new ToastApiError("invalid_response");
  const scaled=Math.abs(value)*100;
  const rounded=Math.floor(scaled+0.5);
  if(!Number.isSafeInteger(rounded))throw new ToastApiError("invalid_response");
  if(Math.abs(scaled-rounded)>0.005+1e-10)onWarning?.("subcent_rounding");
  return Math.sign(value)*rounded;
}
function dateFromNumber(v:number):string|null {
  const s=String(v);
  if(!/^\\d{8}$/.test(s))return null;
  const d=s.slice(0,4)+"-"+s.slice(4,6)+"-"+s.slice(6,8);
  return Number.isFinite(Date.parse(d+"T12:00:00Z"))&&new Date(d+"T12:00:00Z").toISOString().slice(0,10)===d?d:null;
}
function previousDate(d:string):string {
  return new Date(Date.parse(d+"T12:00:00Z")-86400000).toISOString().slice(0,10);
}
function dayOfOrder(o:z.infer<typeof order>,timeZone:string,closeoutHour:number,warn:(k:string)=>void) {
  if(o.businessDate!=null) {
    const date=dateFromNumber(o.businessDate);
    if(!date)throw Error("businessDate");
    return date;
  }
  if(!o.openedDate)throw Error("businessDate");
  const opened=new Date(o.openedDate.replace(/([+-]\\d{2})(\\d{2})$/,"$1:$2"));
  if(!Number.isFinite(opened.getTime()))throw Error("openedDate");
  const date=formatInTimeZone(opened,timeZone,"yyyy-MM-dd");
  const hour=Number(formatInTimeZone(opened,timeZone,"H"));
  warn("business_date_fallback");
  return hour<closeoutHour?previousDate(date):date;
}
function normalize(o:z.infer<typeof order>,restaurantGuid:string,date:string):DayOrder {
  const warnings:Record<string,number>={};
  const warn=(key:string)=>{warnings[key]=(warnings[key]??0)+1;};
  const cents=(v:number|null|undefined)=>toastMoneyCents(v??0,warn);
  const voids:ToastVoidFact[]=[];
  const refundFacts:ToastRefundFact[]=[];
  let before=0,discounts=0,refunds=0,tax=0,tips=0,service=0,gratuity=0,open=0;
  const lines:PosOrder["lines"]=[];
  const excluded=Boolean(o.deleted||o.voided||o.excessFood||o.createdInTestMode);
  for(const c of o.checks??[]) {
    const checkExcluded=excluded||Boolean(c.deleted||c.voided);
    if(!checkExcluded) {
      before+=cents(c.amount);tax+=cents(c.taxAmount);
      if(c.amount==null)warn("missing_amount");
      if(c.paymentStatus==="OPEN"||c.paymentStatus==="PAID")open++;
      else if(!["CLOSED",null,undefined].includes(c.paymentStatus))warn("unknown_shape");
    }
    const ds=(items:z.infer<typeof discount>[],taxIncluded=false)=>{
      for(const d of items) {
        const v=taxIncluded?d.nonTaxDiscountAmount:d.discountAmount;
        if(v==null)warn("missing_discount_amount");
        else discounts+=cents(v);
      }
    };
    if(!checkExcluded)ds(c.appliedDiscounts??[]);
    for(const sc of c.appliedServiceCharges??[]) {
      if(checkExcluded)continue;
      if(sc.gratuity)gratuity+=cents(sc.chargeAmount);
      else if(sc.serviceChargeCategory==="FUNDRAISING_CAMPAIGN")before-=cents(sc.chargeAmount);
      else service+=cents(sc.chargeAmount);
    }
    for(const s of c.selections??[]) {
      const isVoid=Boolean(s.voided||c.voided||o.voided);
      // Deleted/merged checks and orders are not voids.
      if(isVoid&&!o.deleted&&!c.deleted&&!o.createdInTestMode&&!o.excessFood&&s.guid) {
        const basis=s.preDiscountPrice!=null?"preDiscountPrice":s.price!=null?"price":s.receiptLinePrice!=null?"receiptLinePrice":null;
        const raw=basis==="preDiscountPrice"?s.preDiscountPrice:basis==="price"?s.price:
          basis==="receiptLinePrice"?(s.receiptLinePrice??0)*(s.quantity??1)-(s.taxInclusion==="INCLUDED"?(s.tax??0):0):null;
        const voidDate=dateFromNumber(s.voidBusinessDate??c.voidBusinessDate??o.voidBusinessDate??0)??date;
        if(raw===null)warn("void_amount_missing");
        if(!(s.voidBusinessDate??c.voidBusinessDate??o.voidBusinessDate))warn("void_date_fallback");
        voids.push({selection_guid:s.guid,order_guid:o.guid,check_guid:c.guid??null,
          order_business_date:date,void_business_date:voidDate,
          voided_at:s.voidDate??c.voidDate??o.voidDate??null,
          amount_cents:raw===null?null:cents(raw),amount_basis:basis,
          void_reason_guid:s.voidReason?.guid??null,
          level:o.voided?"order":c.voided?"check":"selection"});
      }
      if(checkExcluded||s.deferred||s.selectionType==="HOUSE_ACCOUNT_PAY_BALANCE") {
        if(!checkExcluded&&!s.voided)before-=cents(s.price);
      }
      if(checkExcluded)continue;
      if(!s.voided)ds(s.appliedDiscounts??[],s.taxInclusion==="INCLUDED");
      if(s.quantity==null||s.quantity<=0)warn("invalid_quantity");
      if(s.taxInclusion&&!["INCLUDED","NOT_INCLUDED","INHERITED"].includes(s.taxInclusion))warn("unknown_shape");
      lines.push({posItemId:s.item?.guid?"toast:"+restaurantGuid+":"+s.item.guid:null,
        name:s.displayName?.trim()||"Menu item",quantity:s.quantity??0,
        netSalesCents:s.voided||s.deferred||s.selectionType==="HOUSE_ACCOUNT_PAY_BALANCE"?0:
          cents(s.price)-cents(s.refundDetails?.refundAmount),
        modifiers:(s.modifiers??[]).map(m=>({posModifierId:m.item?.guid??"",name:m.displayName??""})),
        voided:Boolean(s.voided||s.deferred||s.selectionType==="HOUSE_ACCOUNT_PAY_BALANCE"),
        voidedBy:null,category:s.salesCategory?.name??null});
    }
    if(checkExcluded)continue;
    for(const p of c.payments??[]) {
      if(p.paymentStatus==="VOIDED"||p.paymentStatus==="DENIED"||p.paymentStatus==="CANCELLED"||
        p.paymentStatus==="ERROR"||p.paymentStatus==="ERROR_NETWORK")continue;
      if(p.paymentStatus&&!["OPEN","AUTHORIZED","CAPTURED","PAID","CLOSED","REFUNDED"].includes(p.paymentStatus))
        warn("unknown_shape");
      refunds+=cents(p.refund?.refundAmount);
      tips+=cents(p.tipAmount)-cents(p.refund?.tipRefundAmount);
      if(p.refund)refundFacts.push({payment_guid:p.guid??null,
        refund_business_date:dateFromNumber(p.refund.refundBusinessDate??0),
        amount_cents:cents(p.refund.refundAmount)});
    }
  }
  const validChecks=(o.checks??[]).filter(c=>!c.voided&&!c.deleted).length;
  const included=!excluded&&validChecks>0;
  const closed=o.closedDate??o.openedDate;
  if(included&&!closed)throw Error("openedDate");
  const parsedClosed=closed?new Date(closed.replace(/([+-]\\d{2})(\\d{2})$/,"$1:$2")):null;
  if(included&&(!parsedClosed||!Number.isFinite(parsedClosed.getTime())))throw Error("closedDate");
  const normalized:PosOrder|null=!included?null:{
    posOrderId:"toast:"+restaurantGuid+":"+o.guid,posLocationId:restaurantGuid,
    posEmployeeId:o.server?.guid??o.openedBy?.guid??null,
    diningOption:o.diningOption?.name??null,sourceChannel:o.source??null,
    guestCount:o.numberOfGuests??null,closedAt:parsedClosed!.toISOString(),
    grossSalesCents:before+discounts,discountsCents:discounts,
    refundsCents:refunds,taxCents:tax,tipCents:tips,
    processingFeeCents:0,processingFeeStatus:"missing",netSalesCents:before-refunds,lines
  };
  return {guid:o.guid,modifiedAt:o.modifiedDate??o.openedDate??"",
    businessDate:date,normalized,openCheckCount:open,
    serviceChargesCents:service,gratuityCents:gratuity,voids,refundFacts,warnings};
}
/** Process records independently. Never let one malformed order discard its peers. */
export function parseToastDayPage(payload:unknown,opts:{
  restaurantGuid:string;businessDate:string;timeZone:string;closeoutHour:number
}):DayParseResult {
  const parsed=z.array(z.unknown()).safeParse(payload);
  if(!parsed.success)throw new ToastApiError("invalid_response");
  const orders:DayOrder[]=[],unparsed:DayParseResult["unparsed"]=[];
  const warnings:Record<string,number>={};
  if(!GUID.safeParse(opts.restaurantGuid).success||
    !Number.isInteger(opts.closeoutHour)||opts.closeoutHour<0||opts.closeoutHour>12)
    throw new ToastApiError("invalid_response");
  for(const raw of parsed.data) {
    const found=order.safeParse(raw);
    try {
      if(!found.success)throw Error(found.error.issues.map(i=>i.path.join(".")).join(",")||"schema");
      const date=dayOfOrder(found.data,opts.timeZone,opts.closeoutHour,key=>{
        warnings[key]=(warnings[key]??0)+1;
      });
      if(date!==opts.businessDate)throw Error("businessDate");
      const item=normalize(found.data,opts.restaurantGuid,date);
      orders.push(item);
      for(const [key,n] of Object.entries(item.warnings))warnings[key]=(warnings[key]??0)+n;
    }catch(e) {
      const candidate=raw&&typeof raw==="object"?"guid" in raw?(raw as {guid?:unknown}).guid:null:null;
      const guid=typeof candidate==="string"&&GUID.safeParse(candidate).success?candidate:null;
      // The digest is irreversible; no untrusted order JSON or personal data is persisted.
      unparsed.push({order_guid:guid,business_date:opts.businessDate,
        error_path:String(e instanceof Error?e.message:"schema").slice(0,300),
        raw_sha256:createHash("sha256").update(JSON.stringify(raw)??"null").digest("hex")});
    }
  }
  return {orders,unparsed,warnings};
}
