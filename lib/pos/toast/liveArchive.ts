import {redactToastRaw} from "./redact";
import {stableToastOrderPage} from "./stableOrder";

/** An order is finished when it is voided or deleted, or every check on it is
 * closed (or voided). Open and paid-but-not-closed checks still change (tips,
 * items), so they are saved once they close, or by the 5 AM import. This keeps
 * the change log to real late changes instead of every step of an open check. */
export function isFinishedToastOrder(order:unknown):boolean{
 if(!order||typeof order!=="object"||Array.isArray(order))return false;
 const o=order as Record<string,unknown>;
 if(o.voided===true||o.deleted===true)return true;
 if(!Array.isArray(o.checks)||!o.checks.length)return false;
 return o.checks.every(c=>{
  if(!c||typeof c!=="object")return false;
  const check=c as Record<string,unknown>;
  return check.voided===true||check.deleted===true||
   check.paymentStatus==="CLOSED"||check.paymentStatus==="VOIDED";
 });
}

/** One downloaded page of today's orders, prepared exactly as the day import
 * prepares it (lib/pos/toast/dayImport.ts: personal details removed, GUID lists
 * sorted), so an order that does not change before closeout has the same hash
 * at 5 AM and is not saved again. Only finished orders are kept. */
export function liveArchivePage(rows:readonly unknown[]):unknown[]{
 const redacted=redactToastRaw(rows,0,"",undefined,"orders");
 if(!Array.isArray(redacted))return [];
 return stableToastOrderPage(redacted).filter(isFinishedToastOrder);
}
