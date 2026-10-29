/** Sanitized typed fields retained alongside immutable raw Toast provider records.
 * Values not supplied by Toast remain null. No guest/payment credentials leak. */
type JsonRow=Record<string,unknown>;
const row=(x:unknown):JsonRow=>x!==null&&typeof x==="object"&&!Array.isArray(x)?x as JsonRow:{};
const list=(x:unknown):unknown[]=>Array.isArray(x)?x.slice(0,10000):[];
const text=(x:unknown):string|null=>typeof x==="string"&&
 !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(x)&&
 !/(?:\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b|\b\d{13,19}\b)/.test(x)
 ?x.slice(0,200):null;
const guid=(x:unknown):string|null=>typeof x==="string"&&
 /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x)?x:null;
const cents=(x:unknown):number|null=>{
 if(typeof x!=="number"||!Number.isFinite(x))return null;
 const v=Math.sign(x)*Math.round(Math.abs(x)*100+1e-9);
 return Number.isSafeInteger(v)?v:null;
};
const num=(x:unknown):number|null=>typeof x==="number"&&Number.isFinite(x)?x:null;
const duration=(a:unknown,b:unknown):number|null=>{
 if(typeof a!=="string"||typeof b!=="string")return null;
 const start=Date.parse(a.replace(/([+-]\d{2})(\d{2})$/,"$1:$2"));
 const end=Date.parse(b.replace(/([+-]\d{2})(\d{2})$/,"$1:$2"));
 return Number.isFinite(start)&&Number.isFinite(end)&&end>=start?
  Math.round((end-start)/1000):null;
};
type DiscountFact={checkGuid:string|null;selectionGuid:string|null;
 name:string|null;amountCents:number|null;level:"check"|"item"};
export type TypedToastOrderFields={
 orderGuid:string|null;durationSeconds:number|null;checkDiscounts:DiscountFact[];
 itemDiscounts:DiscountFact[];
 itemTaxes:Array<{selectionGuid:string|null;taxAmountCents:number|null;
  taxRate:number|null}>;
 modifierPrices:Array<{selectionGuid:string|null;modifierGuid:string|null;
  priceCents:number|null}>;
 voidDetails:Array<{level:"order"|"check"|"selection";guid:string|null;
  voidBusinessDate:number|null;reasonGuid:string|null}>;
 refundDetails:Array<{level:"selection"|"payment";guid:string|null;
  amountCents:number|null;businessDate:number|null}>;
};
export function extractToastTypedOrderFields(raw:unknown):TypedToastOrderFields{
 const o=row(raw),checkDiscounts:DiscountFact[]=[],itemDiscounts:DiscountFact[]=[];
 const itemTaxes:TypedToastOrderFields["itemTaxes"]=[],modifierPrices:TypedToastOrderFields["modifierPrices"]=[];
 const voidDetails:TypedToastOrderFields["voidDetails"]=[],refundDetails:TypedToastOrderFields["refundDetails"]=[];
 const reference=(v:unknown)=>guid(row(v).guid);
 const asDate=(v:unknown)=>typeof v==="number"&&Number.isInteger(v)?v:null;
 if(o.voided===true)voidDetails.push({level:"order",guid:guid(o.guid),
  voidBusinessDate:asDate(o.voidBusinessDate),reasonGuid:reference(o.voidReason)});
 for(const entry of list(o.checks)){
  const c=row(entry),cGuid=guid(c.guid);
  if(c.voided===true)voidDetails.push({level:"check",guid:cGuid,
   voidBusinessDate:asDate(c.voidBusinessDate),reasonGuid:reference(c.voidReason)});
  for(const d of list(c.appliedDiscounts)){
   const v=row(d);
   checkDiscounts.push({checkGuid:cGuid,selectionGuid:null,name:text(v.name),
    amountCents:cents(v.nonTaxDiscountAmount??v.discountAmount),level:"check"});
  }
  for(const entry of list(c.selections)){
   const s=row(entry),selGuid=guid(s.guid);
   if(s.voided===true)voidDetails.push({level:"selection",guid:selGuid,
    voidBusinessDate:asDate(s.voidBusinessDate),reasonGuid:reference(s.voidReason)});
   itemTaxes.push({selectionGuid:selGuid,taxAmountCents:cents(s.tax),
    taxRate:num(s.taxRate)});
   for(const d of list(s.appliedDiscounts)){
    const v=row(d);
    itemDiscounts.push({checkGuid:cGuid,selectionGuid:selGuid,
     name:text(v.name),amountCents:cents(v.discountAmount??v.nonTaxDiscountAmount),level:"item"});
   }
   if(s.refundDetails!=null){
    const refund=row(s.refundDetails);
    refundDetails.push({level:"selection",guid:selGuid,
     amountCents:cents(refund.refundAmount),businessDate:asDate(refund.refundBusinessDate)});
   }
   const visit=(mods:unknown[],depth:number)=>{
    if(depth>8)return;
    for(const entry of mods){
     const m=row(entry);
     modifierPrices.push({selectionGuid:selGuid,modifierGuid:reference(m.item),
      priceCents:cents(m.price)});
     visit(list(m.modifiers),depth+1);
    }
   };
   visit(list(s.modifiers),0);
  }
  for(const entry of list(c.payments)){
   const p=row(entry);
   if(p.refund!=null){
    const refund=row(p.refund);
    refundDetails.push({level:"payment",guid:guid(p.guid),
     amountCents:cents(refund.refundAmount),businessDate:asDate(refund.refundBusinessDate)});
   }
  }
 }
 return {orderGuid:guid(o.guid),durationSeconds:duration(o.openedDate,o.closedDate),
  checkDiscounts,itemDiscounts,itemTaxes,modifierPrices,voidDetails,refundDetails};
}
export type TypedToastTimeEntryFields={
 regularHours:number|null;overtimeHours:number|null;hourlyWageCents:number|null;
};
export function extractToastTypedTimeEntryFields(raw:unknown):TypedToastTimeEntryFields{
 const r=row(raw);
 return {regularHours:num(r.regularHours),overtimeHours:num(r.overtimeHours),
  hourlyWageCents:cents(r.hourlyWage)};
}
