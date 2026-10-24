import "server-only";
import {createHash} from "node:crypto";
import {formatInTimeZone} from "date-fns-tz";
import {z} from "zod";
import type {PosOrder} from "../types";
import {GUID,ToastApiError} from "./client";

// A single malformed order must not discard its 99 valid page-mates. Passthrough
// accepts newly added Toast fields while validating the money we actually use.
const money=z.number().finite().nullish();
const ref=z.object({guid:GUID}).passthrough().nullish();
const discount=z.object({discountAmount:money,nonTaxDiscountAmount:money}).passthrough();
const service=z.object({chargeAmount:money,gratuity:z.boolean().nullish(),
  serviceChargeCategory:z.string().nullish()}).passthrough();
const selection=z.object({
  guid:GUID.nullish(),item:ref,displayName:z.string().nullish(),
  salesCategory:z.object({name:z.string().nullish()}).passthrough().nullish(),
  quantity:money,price:money,preDiscountPrice:money,receiptLinePrice:money,tax:money,
  taxInclusion:z.string().nullish(),selectionType:z.string().nullish(),
  deferred:z.boolean().nullish(),voided:z.boolean().nullish(),
  voidDate:z.string().nullish(),voidBusinessDate:z.number().int().nullish(),voidReason:ref,
  refundDetails:z.object({refundAmount:money}).passthrough().nullish(),
  appliedDiscounts:z.array(discount).nullish(),
  modifiers:z.array(z.object({item:ref,displayName:z.string().nullish()}).passthrough()).nullish()
}).passthrough();
const payment=z.object({
  guid:GUID.nullish(),paymentStatus:z.string().nullish(),voided:z.boolean().nullish(),
  tipAmount:money,refundStatus:z.string().nullish(),paidBusinessDate:z.number().int().nullish(),
  refund:z.object({refundAmount:money,tipRefundAmount:money,refundBusinessDate:z.number().int().nullish()}).passthrough().nullish()
}).passthrough();
const check=z.object({
  guid:GUID.nullish(),amount:money,taxAmount:money,paymentStatus:z.string().nullish(),
  closedDate:z.string().nullish(),voided:z.boolean().nullish(),deleted:z.boolean().nullish(),
  voidDate:z.string().nullish(),voidBusinessDate:z.number().int().nullish(),
  appliedDiscounts:z.array(discount).nullish(),
  appliedServiceCharges:z.array(service).nullish(),
  selections:z.array(selection).nullish(),payments:z.array(payment).nullish()
}).passthrough();
const order=z.object({
  guid:GUID, businessDate:z.number().int().nullish(), openedDate:z.string().nullish(),
  closedDate:z.string().nullish(),modifiedDate:z.string().nullish(),
  voided:z.boolean().nullish(),deleted:z.boolean().nullish(),
  excessFood:z.boolean().nullish(),createdInTestMode:z.boolean().nullish(),
  voidDate:z.string().nullish(),voidBusinessDate:z.number().int().nullish(),
  server:ref,openedBy:ref,diningOption:z.object({name:z.string().nullish()}).passthrough().nullish(),
  source:z.string().nullish(),numberOfGuests:z.number().int().nullish(),
  checks:z.array(check).nullish()
}).passthrough();
type Order=z.infer<typeof order>;
export type ToastVoidFact={
 selection_guid:string;order_guid:string;check_guid:string|null;order_business_date:string;
 void_business_date:string;voided_at:string|null;amount_cents:number|null;
 amount_basis:"preDiscountPrice"|"price"|"receiptLinePrice"|"amount_missing";
 void_reason_guid:string|null;level:"selection"|"check"|"order"
};
export type ToastRefundFact={payment_guid:string;order_guid:string;
 order_business_date:string;refund_business_date:string|null;amount_cents:number};
export type ToastParsedOrder={guid:string;modifiedDate:string;normalized:PosOrder|null;
 voids:ToastVoidFact[];refundFacts:ToastRefundFact[];
 includedChecks:number;openChecks:number;serviceChargesCents:number;gratuityCents:number;
 warnings:Record<string,number>};
export type ToastUnparsed={order_guid:string|null;business_date:string;
 error_path:string;raw_sha256:string};
export type ToastDayPage={orders:ToastParsedOrder[];unparsed:ToastUnparsed[];
 warnings:Record<string,number>};

function warn(w:Record<string,number>,key:string){w[key]=(w[key]??0)+1;}
export function toastCents(value:number):number {
 if(!Number.isFinite(value))throw new ToastApiError("invalid_response");
 const cents=Math.sign(value)*Math.round(Math.abs(value)*100+1e-9);
 if(!Number.isSafeInteger(cents))throw new ToastApiError("invalid_response");
 return cents;
}
function cents(value:number|null|undefined,w:Record<string,number>):number{
 if(value==null)return 0;
 const c=toastCents(value);
 if(Math.abs(value*100-c)>0.005)warn(w,"subcent_rounding");
 return c;
}
function date8(input:number|null|undefined):string|null{
 if(input==null)return null;
 const s=String(input);
 if(!/^\d{8}$/.test(s))return null;
 const y=s.slice(0,4),m=s.slice(4,6),d=s.slice(6);
 const iso=y+"-"+m+"-"+d;
 return Number.isFinite(Date.parse(iso+"T12:00:00Z"))&&
   new Date(iso+"T12:00:00Z").toISOString().slice(0,10)===iso?iso:null;
}
function fallbackDate(opened:string|null|undefined,timezone:string,closeout:number):string|null{
 if(!opened||!Number.isFinite(Date.parse(opened)))return null;
 const at=new Date(opened);
 const local=formatInTimeZone(at,timezone,"yyyy-MM-dd HH:mm:ss");
 const localHour=Number(local.slice(11,13));
 const ymd=local.slice(0,10);
 return localHour<closeout
  ?new Date(Date.parse(ymd+"T12:00:00Z")-86400000).toISOString().slice(0,10)
  :ymd;
}
function isoDate(s:string|null|undefined):string|null{
 if(!s)return null;
 const at=Date.parse(s);
 return Number.isFinite(at)?new Date(at).toISOString():null;
}
function known(w:Record<string,number>,value:string|null|undefined,allowed:readonly string[]){
 if(value&&!allowed.includes(value))warn(w,"unknown_shape");
}
function addDiscounts(ds:z.infer<typeof discount>[]|null|undefined,checkLevel:boolean,w:Record<string,number>):number{
 let result=0;
 for(const d of ds??[]){
  // Check-level discounts use discountAmount. Tax-inclusive selections use
  // the non-tax portion to avoid treating a tax adjustment as a sale.
  const value=checkLevel?d.discountAmount:d.nonTaxDiscountAmount??d.discountAmount;
  if(value==null)warn(w,"missing_discount_amount");
  result+=cents(value,w);
 }
 return result;
}
function redact(value:unknown):string{
 return JSON.stringify(value,(key,v)=>/token|secret|password|email|phone|card|address|customer|guest|name/i.test(key)?"[redacted]":v)??"null";
}
export function parseToastBusinessOrder(payload:unknown,restaurantGuid:string,
 requestedDay:string,timezone:string,closeoutHour:number):ToastParsedOrder{
 const parsed=order.safeParse(payload);
 if(!parsed.success)throw new ToastOrderParseError(
  parsed.error.issues.map(i=>i.path.join(".")||"$").slice(0,8).join(","));
 const o:Order=parsed.data,w:Record<string,number>={};
 const day=date8(o.businessDate)??fallbackDate(o.openedDate,timezone,closeoutHour);
 if(!day)throw new ToastOrderParseError("businessDate");
 if(!date8(o.businessDate))warn(w,"business_date_fallback");
 if(day!==requestedDay)throw new ToastOrderParseError("businessDate_mismatch");
 const voids:ToastVoidFact[]=[],refundFacts:ToastRefundFact[]=[];
 let before=0,discounts=0,refunds=0,tax=0,tips=0,gratuity=0,services=0;
 let includedChecks=0,openChecks=0;
 const lines:PosOrder["lines"]=[];
 const excluded=Boolean(o.deleted||o.voided||o.excessFood||o.createdInTestMode);
 for(const c of o.checks??[]){
  const active=!excluded&&!c.deleted&&!c.voided;
  if(active){includedChecks++;if(c.paymentStatus==="OPEN"||c.paymentStatus==="PAID")openChecks++;}
  known(w,c.paymentStatus,["OPEN","PAID","CLOSED", "VOIDED"]);
  if(active){
   before+=cents(c.amount,w);tax+=cents(c.taxAmount,w);
   discounts+=addDiscounts(c.appliedDiscounts,true,w);
   for(const sc of c.appliedServiceCharges??[]){
    const value=cents(sc.chargeAmount,w);
    if(sc.serviceChargeCategory==="FUNDRAISING_CAMPAIGN")before-=value;
    else if(sc.gratuity)gratuity+=value;
    else services+=value;
    known(w,sc.serviceChargeCategory,["FUNDRAISING_CAMPAIGN","SERVICE_CHARGE","DELIVERY","OTHER"]);
   }
  }
  for(const s of c.selections??[]){
   const isVoid=!o.deleted&&!c.deleted&&!o.excessFood&&!o.createdInTestMode&&
     Boolean(o.voided||c.voided||s.voided);
   if(isVoid){
    if(!s.guid)throw new ToastOrderParseError("checks.selections.guid");
    let amount:number|null=null, basis:ToastVoidFact["amount_basis"]="amount_missing";
    if(s.preDiscountPrice!=null){amount=cents(s.preDiscountPrice,w);basis="preDiscountPrice";}
    else if(s.price!=null){amount=cents(s.price,w);basis="price";}
    else if(s.receiptLinePrice!=null){
      const original=cents(s.receiptLinePrice*(s.quantity??1),w);
      amount=s.taxInclusion==="INCLUDED"?original-cents(s.tax,w):original;
      basis="receiptLinePrice";
    }
    const voidDay:string=date8(s.voidBusinessDate)??date8(c.voidBusinessDate)??date8(o.voidBusinessDate)??day;
    if(voidDay===day&&!s.voidBusinessDate&&!c.voidBusinessDate&&!o.voidBusinessDate)warn(w,"void_date_fallback");
    voids.push({selection_guid:s.guid,order_guid:o.guid,check_guid:c.guid??null,
      order_business_date:day,void_business_date:voidDay,
      voided_at:isoDate(s.voidDate??c.voidDate??o.voidDate),
      amount_cents:amount,amount_basis:basis,void_reason_guid:s.voidReason?.guid??null,
      level:o.voided?"order":c.voided?"check":"selection"});
   }
   if(!active)continue;
   known(w,s.taxInclusion,["INCLUDED","NOT_INCLUDED","INHERITED"]);
   known(w,s.selectionType,["NONE","HOUSE_ACCOUNT_PAY_BALANCE","GIFT_CARD","OPEN_ITEM","COMBO","MODIFIER"]);
   const deferred=Boolean(s.deferred||s.selectionType==="HOUSE_ACCOUNT_PAY_BALANCE");
   if(deferred&&!s.voided)before-=cents(s.price,w);
   if(s.voided&&!isVoid)warn(w,"unknown_shape");
   if(s.quantity!=null&&s.quantity<=0)warn(w,"nonpositive_quantity");
   if(!s.voided&&!deferred){
    discounts+=addDiscounts((s.appliedDiscounts??[]).map(d=>({
      ...d,
      nonTaxDiscountAmount:s.taxInclusion==="INCLUDED"?d.nonTaxDiscountAmount:d.discountAmount
    })),false,w);
   }
   // Voided selections are retained with zero net and never count as sold.
   if(!deferred){
    lines.push({posItemId:s.item?.guid?"toast:"+restaurantGuid+":"+s.item.guid:null,
      name:s.displayName?.trim()||"Menu item",quantity:s.quantity??0,
      netSalesCents:s.voided?0:cents(s.price,w)-cents(s.refundDetails?.refundAmount,w),
      voided:Boolean(s.voided),voidedBy:null,
      category:s.salesCategory?.name?.trim()||null,
      modifiers:(s.modifiers??[]).map(m=>({
        posModifierId:m.item?.guid??"",name:m.displayName??""
      }))});
   }
  }
  if(!active)continue;
  for(const p of c.payments??[]){
   known(w,p.paymentStatus,["OPEN","PAID","CLOSED","AUTHORIZED","CAPTURED","VOIDED","DENIED","CANCELLED","ERROR","ERROR_NETWORK"]);
   const invalid=p.voided||["VOIDED","DENIED","CANCELLED","ERROR","ERROR_NETWORK"].includes(p.paymentStatus??"");
   if(invalid)continue;
   const amount=cents(p.refund?.refundAmount,w);
   refunds+=amount;
   tips+=cents(p.tipAmount,w)-cents(p.refund?.tipRefundAmount,w);
   if(amount){
    refundFacts.push({payment_guid:p.guid??o.guid,order_guid:o.guid,order_business_date:day,
      refund_business_date:date8(p.refund?.refundBusinessDate),amount_cents:amount});
    if(!p.guid)warn(w,"refund_payment_guid_missing");
   }
  }
 }
 // Toast: check.amount ALREADY includes discounts and ordinary service charges,
 // excludes tax and gratuity. Subtract deferred/house-account items, fundraising
 // and payment refunds only. OPEN and PAID checks are included.
 const normalized:PosOrder|null=includedChecks?{
  posOrderId:"toast:"+restaurantGuid+":"+o.guid,posLocationId:restaurantGuid,
  posEmployeeId:o.server?.guid??o.openedBy?.guid??null,
  diningOption:o.diningOption?.name?.trim()||null,sourceChannel:o.source?.trim()||null,
  guestCount:o.numberOfGuests??null,
  closedAt:isoDate(o.closedDate)||isoDate(o.openedDate)||new Date(requestedDay+"T12:00:00Z").toISOString(),
  grossSalesCents:before+discounts,discountsCents:discounts,refundsCents:refunds,
  taxCents:tax,tipCents:tips,netSalesCents:before-refunds,
  processingFeeCents:0,processingFeeStatus:"missing",lines
 }:null;
 return {guid:o.guid,modifiedDate:isoDate(o.modifiedDate)||"",
  normalized,voids,refundFacts,includedChecks,openChecks,
  serviceChargesCents:services,gratuityCents:gratuity,warnings:w};
}
export class ToastOrderParseError extends Error{}
export function parseToastDayPage(payload:unknown,restaurantGuid:string,day:string,
 timezone:string,closeoutHour:number):ToastDayPage{
 const rows=z.array(z.unknown()).safeParse(payload);
 if(!rows.success)throw new ToastApiError("invalid_response");
 const result:ToastDayPage={orders:[],unparsed:[],warnings:{}};
 for(const row of rows.data){
  try{
   const record=parseToastBusinessOrder(row,restaurantGuid,day,timezone,closeoutHour);
   result.orders.push(record);
   for(const [key,count] of Object.entries(record.warnings))
    result.warnings[key]=(result.warnings[key]??0)+count;
  }catch(e){
   const rawGuid=typeof row==="object"&&row!==null&&"guid" in row?(row as {guid:unknown}).guid:null;
   result.unparsed.push({order_guid:typeof rawGuid==="string"&&GUID.safeParse(rawGuid).success?rawGuid:null,
    business_date:day,error_path:e instanceof ToastOrderParseError?e.message:"$",
    raw_sha256:createHash("sha256").update(redact(row)).digest("hex")});
  }
 }
 return result;
}
