import "server-only";
import {createHmac,randomUUID} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {z} from "zod";
import {fromZonedTime} from "date-fns-tz";
import {createToastClient,GUID,ToastApiError,toToastTimestamp} from "./client";
import {createToastAnalyticsClient} from "./analyticsClient";

type Scope="date"|"window"|"none"|"restaurant"|"id"|"unsupported";
type Entry={endpoint:string;path:string;doc:string;scope:Scope;page?:boolean;source?:string};
const doc=(family:string,operation:string)=>"https://doc.toasttab.com/openapi/"+family+"/operation/"+operation;
const entry=(endpoint:string,path:string,family:string,operation:string,scope:Scope="none",page=false,source?:string):Entry=>
 ({endpoint,path,doc:doc(family,operation),scope,page,source});
/** Explicit inventory; each operation is attempted or recorded as a prerequisite/method gap. */
/** 88 GET operations from the 20 Toast OpenAPI specs (2026-10-28). */
export const TOAST_READ_ENDPOINTS:readonly Entry[]=[{"endpoint":"orders/v2/ordersBulk","path":"/orders/v2/ordersBulk","doc":"https://doc.toasttab.com/openapi/orders/operation/ordersBulkGet/","scope":"date","page":true},{"endpoint":"orders/v2/payments","path":"/orders/v2/payments","doc":"https://doc.toasttab.com/openapi/orders/operation/paymentsGet/","scope":"date"},{"endpoint":"orders/v2/orders","path":"/orders/v2/orders","doc":"https://doc.toasttab.com/openapi/orders/operation/ordersGet/","scope":"date"},{"endpoint":"menus/v2/menus","path":"/menus/v2/menus","doc":"https://doc.toasttab.com/openapi/menus/operation/menusGet/","scope":"none"},{"endpoint":"menus/v2/metadata","path":"/menus/v2/metadata","doc":"https://doc.toasttab.com/openapi/menus/operation/metadataGet/","scope":"none"},{"endpoint":"menus/v3/menus","path":"/menus/v3/menus","doc":"https://doc.toasttab.com/openapi/menusv3/operation/menusGet/","scope":"none"},{"endpoint":"menus/v3/metadata","path":"/menus/v3/metadata","doc":"https://doc.toasttab.com/openapi/menusv3/operation/metadataGet/","scope":"none"},{"endpoint":"config/v2/alternatePaymentTypes","path":"/config/v2/alternatePaymentTypes","doc":"https://doc.toasttab.com/openapi/configuration/operation/alternatePaymentTypesGet/","scope":"none","page":true},{"endpoint":"config/v2/breakTypes","path":"/config/v2/breakTypes","doc":"https://doc.toasttab.com/openapi/configuration/operation/breakTypesGet/","scope":"none","page":true},{"endpoint":"config/v2/cashDrawers","path":"/config/v2/cashDrawers","doc":"https://doc.toasttab.com/openapi/configuration/operation/cashDrawersGet/","scope":"none","page":true},{"endpoint":"config/v2/diningOptions","path":"/config/v2/diningOptions","doc":"https://doc.toasttab.com/openapi/configuration/operation/diningOptionsGet/","scope":"none","page":true},{"endpoint":"config/v2/discounts","path":"/config/v2/discounts","doc":"https://doc.toasttab.com/openapi/configuration/operation/discountsGet/","scope":"none","page":true},{"endpoint":"config/v2/menuGroups","path":"/config/v2/menuGroups","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuGroupsGet/","scope":"none","page":true},{"endpoint":"config/v2/menuItems","path":"/config/v2/menuItems","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuItemsGet/","scope":"none","page":true},{"endpoint":"config/v2/menuOptionGroups","path":"/config/v2/menuOptionGroups","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuOptionGroupsGet/","scope":"none","page":true},{"endpoint":"config/v2/menus","path":"/config/v2/menus","doc":"https://doc.toasttab.com/openapi/configuration/operation/menusGet/","scope":"none","page":true},{"endpoint":"config/v2/noSaleReasons","path":"/config/v2/noSaleReasons","doc":"https://doc.toasttab.com/openapi/configuration/operation/noSaleReasonsGet/","scope":"none","page":true},{"endpoint":"config/v2/payoutReasons","path":"/config/v2/payoutReasons","doc":"https://doc.toasttab.com/openapi/configuration/operation/payoutReasonsGet/","scope":"none","page":true},{"endpoint":"config/v2/preModifierGroups","path":"/config/v2/preModifierGroups","doc":"https://doc.toasttab.com/openapi/configuration/operation/preModifierGroupsGet/","scope":"none","page":true},{"endpoint":"config/v2/preModifiers","path":"/config/v2/preModifiers","doc":"https://doc.toasttab.com/openapi/configuration/operation/preModifiersGet/","scope":"none","page":true},{"endpoint":"config/v2/priceGroups","path":"/config/v2/priceGroups","doc":"https://doc.toasttab.com/openapi/configuration/operation/priceGroupsGet/","scope":"none","page":true},{"endpoint":"config/v2/printers","path":"/config/v2/printers","doc":"https://doc.toasttab.com/openapi/configuration/operation/printersGet/","scope":"none","page":true},{"endpoint":"config/v2/restaurantServices","path":"/config/v2/restaurantServices","doc":"https://doc.toasttab.com/openapi/configuration/operation/restaurantServicesGet/","scope":"none","page":true},{"endpoint":"config/v2/revenueCenters","path":"/config/v2/revenueCenters","doc":"https://doc.toasttab.com/openapi/configuration/operation/revenueCentersGet/","scope":"none","page":true},{"endpoint":"config/v2/salesCategories","path":"/config/v2/salesCategories","doc":"https://doc.toasttab.com/openapi/configuration/operation/salesCategoriesGet/","scope":"none","page":true},{"endpoint":"config/v2/serviceAreas","path":"/config/v2/serviceAreas","doc":"https://doc.toasttab.com/openapi/configuration/operation/serviceAreasGet/","scope":"none","page":true},{"endpoint":"config/v2/serviceCharges","path":"/config/v2/serviceCharges","doc":"https://doc.toasttab.com/openapi/configuration/operation/serviceChargesGet/","scope":"none","page":true},{"endpoint":"config/v2/tables","path":"/config/v2/tables","doc":"https://doc.toasttab.com/openapi/configuration/operation/tablesGet/","scope":"none","page":true},{"endpoint":"config/v2/taxRates","path":"/config/v2/taxRates","doc":"https://doc.toasttab.com/openapi/configuration/operation/taxRatesGet/","scope":"none","page":true},{"endpoint":"config/v2/tipWithholding","path":"/config/v2/tipWithholding","doc":"https://doc.toasttab.com/openapi/configuration/operation/tipWithholdingGet/","scope":"none","page":true},{"endpoint":"config/v2/voidReasons","path":"/config/v2/voidReasons","doc":"https://doc.toasttab.com/openapi/configuration/operation/voidReasonsGet/","scope":"none","page":true},{"endpoint":"labor/v1/employees","path":"/labor/v1/employees","doc":"https://doc.toasttab.com/openapi/labor/operation/employeesGet/","scope":"none"},{"endpoint":"labor/v1/jobs","path":"/labor/v1/jobs","doc":"https://doc.toasttab.com/openapi/labor/operation/jobsGet/","scope":"none"},{"endpoint":"labor/v1/shifts","path":"/labor/v1/shifts","doc":"https://doc.toasttab.com/openapi/labor/operation/shiftsGet/","scope":"window"},{"endpoint":"labor/v1/timeEntries","path":"/labor/v1/timeEntries","doc":"https://doc.toasttab.com/openapi/labor/operation/timeEntriesGet/","scope":"window"},{"endpoint":"cashmgmt/v1/deposits","path":"/cashmgmt/v1/deposits","doc":"https://doc.toasttab.com/openapi/cashmanagement/operation/depositsGet/","scope":"date"},{"endpoint":"cashmgmt/v1/entries","path":"/cashmgmt/v1/entries","doc":"https://doc.toasttab.com/openapi/cashmanagement/operation/entriesGet/","scope":"date"},{"endpoint":"stock/v1/inventory","path":"/stock/v1/inventory","doc":"https://doc.toasttab.com/openapi/stock/operation/getInventory/","scope":"none"},{"endpoint":"kitchen/v1/export/itemFulfillments","path":"/kitchen/v1/export/itemFulfillments","doc":"https://doc.toasttab.com/openapi/kitchen/operation/itemFulfillmentsGet/","scope":"date"},{"endpoint":"kitchen/v1/published/prepStations","path":"/kitchen/v1/published/prepStations","doc":"https://doc.toasttab.com/openapi/kitchen/operation/prepStationsGet/","scope":"none","page":true},{"endpoint":"partners/v1/connectedRestaurants","path":"/partners/v1/connectedRestaurants","doc":"https://doc.toasttab.com/openapi/partners/operation/connectedRestaurantsGet/","scope":"none","page":true},{"endpoint":"partners/v1/restaurants","path":"/partners/v1/restaurants","doc":"https://doc.toasttab.com/openapi/partners/operation/restaurantsGet/","scope":"none"},{"endpoint":"packaging/v1/published/packagingConfig","path":"/packaging/v1/published/packagingConfig","doc":"https://doc.toasttab.com/openapi/packaging/operation/getPackagingConfig/","scope":"none"},{"endpoint":"restaurant-availability/v1/availability","path":"/restaurant-availability/v1/availability","doc":"https://doc.toasttab.com/openapi/rx.availability.service/operation/availabilityGet/","scope":"none"},{"endpoint":"ordermgmt/v1/published/orderingSchedule","path":"/ordermgmt/v1/published/orderingSchedule","doc":"https://doc.toasttab.com/openapi/ordermgmt.configuration/operation/orderingScheduleGet/","scope":"none"},{"endpoint":"era/v1/restaurants-information","path":"/era/v1/restaurants-information","doc":"https://doc.toasttab.com/openapi/analytics/operation/getManagementGroupRestaurantsInformation/","scope":"none"},{"endpoint":"device-details/v1/device-info","path":"/device-details/v1/device-info","doc":"https://doc.toasttab.com/openapi/devicedetails/operation/getDeviceInfo/","scope":"none"},{"endpoint":"restaurants/v1/restaurants/{restaurantGUID}","path":"/restaurants/v1/restaurants/{restaurantGUID}","doc":"https://doc.toasttab.com/openapi/restaurants/operation/restaurantsRestaurantGuidGet/","scope":"restaurant"},{"endpoint":"orders/v2/payments/{guid}","path":"/orders/v2/payments/{guid}","doc":"https://doc.toasttab.com/openapi/orders/operation/paymentsGuidGet/","scope":"id","source":"orders/v2/payments"},{"endpoint":"orders/v2/orders/{guid}","path":"/orders/v2/orders/{guid}","doc":"https://doc.toasttab.com/openapi/orders/operation/ordersGuidGet/","scope":"id","source":"orders/v2/ordersBulk"},{"endpoint":"config/v2/alternatePaymentTypes/{guid}","path":"/config/v2/alternatePaymentTypes/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/alternatePaymentTypesGuidGet/","scope":"id","source":"config/v2/alternatePaymentTypes"},{"endpoint":"config/v2/breakTypes/{guid}","path":"/config/v2/breakTypes/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/breakTypesGuidGet/","scope":"id","source":"config/v2/breakTypes"},{"endpoint":"config/v2/cashDrawers/{guid}","path":"/config/v2/cashDrawers/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/cashDrawersGuidGet/","scope":"id","source":"config/v2/cashDrawers"},{"endpoint":"config/v2/diningOptions/{guid}","path":"/config/v2/diningOptions/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/diningOptionsGuidGet/","scope":"id","source":"config/v2/diningOptions"},{"endpoint":"config/v2/discounts/{guid}","path":"/config/v2/discounts/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/discountsGuidGet/","scope":"id","source":"config/v2/discounts"},{"endpoint":"config/v2/menuGroups/{guid}","path":"/config/v2/menuGroups/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuGroupsGuidGet/","scope":"id","source":"config/v2/menuGroups"},{"endpoint":"config/v2/menuItems/{guid}","path":"/config/v2/menuItems/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuItemsGuidGet/","scope":"id","source":"config/v2/menuItems"},{"endpoint":"config/v2/menuOptionGroups/{guid}","path":"/config/v2/menuOptionGroups/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuOptionGroupsGuidGet/","scope":"id","source":"config/v2/menuOptionGroups"},{"endpoint":"config/v2/menus/{guid}","path":"/config/v2/menus/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/menusGuidGet/","scope":"id","source":"config/v2/menus"},{"endpoint":"config/v2/noSaleReasons/{guid}","path":"/config/v2/noSaleReasons/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/noSaleReasonsGuidGet/","scope":"id","source":"config/v2/noSaleReasons"},{"endpoint":"config/v2/payoutReasons/{guid}","path":"/config/v2/payoutReasons/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/payoutReasonsGuidGet/","scope":"id","source":"config/v2/payoutReasons"},{"endpoint":"config/v2/preModifierGroups/{guid}","path":"/config/v2/preModifierGroups/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/preModifierGroupsGuidGet/","scope":"id","source":"config/v2/preModifierGroups"},{"endpoint":"config/v2/preModifiers/{guid}","path":"/config/v2/preModifiers/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/preModifiersGuidGet/","scope":"id","source":"config/v2/preModifiers"},{"endpoint":"config/v2/priceGroups/{guid}","path":"/config/v2/priceGroups/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/priceGroupsGuidGet/","scope":"id","source":"config/v2/priceGroups"},{"endpoint":"config/v2/printers/{guid}","path":"/config/v2/printers/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/printersGuidGet/","scope":"id","source":"config/v2/printers"},{"endpoint":"config/v2/restaurantServices/{guid}","path":"/config/v2/restaurantServices/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/restaurantServicesGuidGet/","scope":"id","source":"config/v2/restaurantServices"},{"endpoint":"config/v2/revenueCenters/{guid}","path":"/config/v2/revenueCenters/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/revenueCentersGuidGet/","scope":"id","source":"config/v2/revenueCenters"},{"endpoint":"config/v2/salesCategories/{guid}","path":"/config/v2/salesCategories/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/salesCategoriesGuidGet/","scope":"id","source":"config/v2/salesCategories"},{"endpoint":"config/v2/serviceAreas/{guid}","path":"/config/v2/serviceAreas/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/serviceAreasGuidGet/","scope":"id","source":"config/v2/serviceAreas"},{"endpoint":"config/v2/serviceCharges/{guid}","path":"/config/v2/serviceCharges/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/serviceChargesGuidGet/","scope":"id","source":"config/v2/serviceCharges"},{"endpoint":"config/v2/tables/{guid}","path":"/config/v2/tables/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/tablesGuidGet/","scope":"id","source":"config/v2/tables"},{"endpoint":"config/v2/taxRates/{guid}","path":"/config/v2/taxRates/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/taxRatesGuidGet/","scope":"id","source":"config/v2/taxRates"},{"endpoint":"config/v2/voidReasons/{guid}","path":"/config/v2/voidReasons/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/voidReasonsGuidGet/","scope":"id","source":"config/v2/voidReasons"},{"endpoint":"labor/v1/employees/{employeeId}","path":"/labor/v1/employees/{employeeId}","doc":"https://doc.toasttab.com/openapi/labor/operation/employeesEmployeeIdGet/","scope":"id","source":"labor/v1/employees"},{"endpoint":"labor/v1/jobs/{jobId}","path":"/labor/v1/jobs/{jobId}","doc":"https://doc.toasttab.com/openapi/labor/operation/jobsJobIdGet/","scope":"id","source":"labor/v1/jobs"},{"endpoint":"labor/v1/shifts/{shiftId}","path":"/labor/v1/shifts/{shiftId}","doc":"https://doc.toasttab.com/openapi/labor/operation/shiftsShiftIdGet/","scope":"id","source":"labor/v1/shifts"},{"endpoint":"labor/v1/timeEntries/{timeEntryId}","path":"/labor/v1/timeEntries/{timeEntryId}","doc":"https://doc.toasttab.com/openapi/labor/operation/timeEntriesTimeEntryIdGet/","scope":"id","source":"labor/v1/timeEntries"},{"endpoint":"kitchen/v1/published/prepStations/{guid}","path":"/kitchen/v1/published/prepStations/{guid}","doc":"https://doc.toasttab.com/openapi/kitchen/operation/prepStationsGuidGet/","scope":"id","source":"kitchen/v1/published/prepStations"},{"endpoint":"restaurants/v1/groups/{managementGroupGUID}/restaurants","path":"/restaurants/v1/groups/{managementGroupGUID}/restaurants","doc":"https://doc.toasttab.com/openapi/restaurants/operation/groupsManagementGroupGuidRestaurantsGet/","scope":"id","source":"__management_group__"},{"endpoint":"era/v1/check/{reportRequestGuid}","path":"/era/v1/check/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getCheckReportingData/","scope":"id","source":"__era_report__"},{"endpoint":"era/v1/guest/payments/{reportRequestGuid}","path":"/era/v1/guest/payments/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getGuestByPaymentDateReportingData/","scope":"id","source":"__era_report__"},{"endpoint":"era/v1/labor/{reportRequestGuid}","path":"/era/v1/labor/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getLaborReportingData/","scope":"id","source":"__era_report__"},{"endpoint":"era/v1/menu/{reportRequestGuid}","path":"/era/v1/menu/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getMenuReportingData/","scope":"id","source":"__era_report__"},{"endpoint":"era/v1/metrics/{reportRequestGuid}","path":"/era/v1/metrics/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getMetricsReportingData/","scope":"id","source":"__era_report__"},{"endpoint":"era/v1/metrics/{timeRange}/{reportRequestGuid}","path":"/era/v1/metrics/day/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getMetricsReportingDataSpecificTimeRange/","scope":"id","source":"__era_report__"},{"endpoint":"era/v1/payout/{reportRequestGuid}","path":"/era/v1/payout/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getPayoutSettledDateReportingData/","scope":"id","source":"__era_report__"},{"endpoint":"era/v1/payout/payments/{reportRequestGuid}","path":"/era/v1/payout/payments/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getPayoutPaymentsReportingData/","scope":"id","source":"__era_report__"},{"endpoint":"era/v1/payout/sales-date/{reportRequestGuid}","path":"/era/v1/payout/sales-date/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getPayoutSalesDateReportingData/","scope":"id","source":"__era_report__"},{"endpoint":"era/v1/metrics/day","path":"/era/v1/metrics/day","doc":"https://doc.toasttab.com/openapi/analytics/operation/postMetricsReportingDataSpecificTimeRange/","scope":"unsupported"},{"endpoint":"authentication/no_get_operations","path":"/","doc":"https://doc.toasttab.com/openapi/authentication/overview/","scope":"unsupported"},{"endpoint":"creditcards/no_get_operations","path":"/","doc":"https://doc.toasttab.com/openapi/creditcards/overview/","scope":"unsupported"},{"endpoint":"giftcards/no_get_operations","path":"/","doc":"https://doc.toasttab.com/openapi/giftcards/overview/","scope":"unsupported"},{"endpoint":"loyalty/no_get_operations","path":"/","doc":"https://doc.toasttab.com/openapi/loyalty/overview/","scope":"unsupported"},{"endpoint":"tender/no_get_operations","path":"/","doc":"https://doc.toasttab.com/openapi/tender/overview/","scope":"unsupported"}];
const ISO=z.iso.date();
const PAGE_CAP=20;
const PAGE_SIZE=100;
const CHUNK_BYTES=180000;
const RESTRICTED=/(?:password|secret|token|credential|authorization|api.?key|session|cookie|signature|passcode|pin$|ssn|social.?security|routing|account.?number|pan$|cvv|cvc|first.?6|last.?4|last.?four|cardholder|card.?network.?id|^networkId$|^cardName$|card.?number|card.?digits|^networkTransactionIdentifier$|customer.?name|guest.?name|employee.?name|patron.?name|magstripe|track.?data|expir|email|phone|mobile|fax|birth|first.?name|last.?name|full.?name|chosen.?name|street|address|postal|zip.?code|latitude|longitude|^lat$|^lon$|^lng$|ip.?address|device.?id)/i;
const FREEFORM=/(?:notes?|memo|comment|message|instructions|^text$|description|receiptText|^tabName$)/i;
const IDENTIFIER=/(?:^customer(?:Id|Guid)$|^guest(?:Id|Guid)$|^loyalty(?:Id|Guid|AccountId|AccountGuid|CustomerId|CustomerGuid)$|^cardPaymentId$|^cardFingerprint$|^cardTokenId$|^paymentCardId$|^cardId$|^networkTransactionIdentifier$|^maskedLoyaltyIdentifier$|^customerIdentifier$|^loyaltyIdentifier$)/i;
const KEY=/^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
const isLinkableId=(name:string,context:string)=>IDENTIFIER.test(name)||
 /^(?:id|guid|referenceId|externalId|accountId|accountGuid|fingerprint|tokenId|identifier)$/i.test(name)&&
 /(?:customer|guest|loyalty|card|patron|employee|staff|cashier)/i.test(context);
function safeString(s:string){return s.length<=100000&&!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s)&&!/(?:\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\b\d{13,19}\b)/.test(s);}
export function redactToastRaw(value:unknown,depth=0,key="",hashKey?:string,context="",scope=""):unknown{
 if(depth>32)return null;
 if(Array.isArray(value))return value.map(v=>redactToastRaw(v,depth+1,key,hashKey,context,scope));
 if(value&&typeof value==="object"){
  const obj=value as Record<string,unknown>;
  return Object.fromEntries(Object.entries(obj).filter(([k])=>KEY.test(k)||/^[0-9]{1,6}$/.test(k))
   .filter(([k])=>(isLinkableId(k,context)||!RESTRICTED.test(k))&&
     (!FREEFORM.test(k)||k==="description"&&/^(?:config|menus)\//.test(scope)))
   .filter(([k,v])=>{
    const sensitive=/(?:customer|guest|employee|staff|person|cardholder|loyalty|patron|deliveryInfo|contact|billing|shipping|recipient|buyer|payer|cashier|^card$)/i.test(context);
    if(!sensitive)return true;
    if(/(?:^name$|displayName|nickname|^text$|city|state|country|^fullName$)/i.test(k))return false;
    if(typeof v!=="string")return true;
    return isLinkableId(k,context)||/^(?:type|status|entityType|cardType|cardEntryMode|jobTitle|jobCode|title|currency)$/i.test(k);
   })
   .map(([k,v])=>[k,redactToastRaw(v,depth+1,k,hashKey,/(?:customer|guest|employee|staff|person|cardholder|loyalty|patron|deliveryInfo|contact|billing|shipping|recipient|buyer|payer|cashier|^card$)/i.test(k)?k:context,scope)])
   .filter(([k,v])=>v!==undefined));
 }
 if(isLinkableId(key,context)){
  if(!hashKey) return undefined;
  if(typeof value!=="string"&&typeof value!=="number")return null;
  return "hmac:"+createHmac("sha256",hashKey).update(String(value)).digest("hex");
 }
 if(typeof value==="string")return safeString(value)?value:"[redacted]";
 return value;
}
export function toastFieldPaths(value:unknown):string[]{
 const out=new Set<string>();
 const walk=(v:unknown,p:string,d:number)=>{
  if(d>32)return;
  if(Array.isArray(v)){if(p)out.add(p+"[]");for(const x of v)walk(x,p+"[]",d+1);}
  else if(v&&typeof v==="object")for(const [k,x] of Object.entries(v)){
   const n=p?p+"."+k:k;out.add(n);walk(x,n,d+1);
  }
 };
 walk(value,"",0);return [...out].sort();
}
function identifierCounts(value:unknown){
 const counts:Record<string,{present:number;filled:number}>={};
 const walk=(v:unknown,path:string,d:number)=>{
  if(d>32)return;
  if(Array.isArray(v)){for(const x of v)walk(x,path+"[]",d+1);return;}
  if(!v||typeof v!=="object")return;
  for(const [k,x] of Object.entries(v)){
   const safeKey=KEY.test(k)||/^[0-9]{1,6}$/.test(k)?k:"*";
   const next=path?path+"."+safeKey:safeKey;
   if(isLinkableId(k,path)){
    const s=counts[next]??{present:0,filled:0};
    s.present++;if(x!==null&&x!==undefined&&x!=="")s.filled++;
    counts[next]=s;
   }
   walk(x,next,d+1);
  }
 };
 walk(value,"",0);return counts;
}
function chunks(raw:unknown):unknown[]{
 const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v)??"null","utf8");
 const split=(v:unknown,depth:number):unknown[]=>{
  if(bytes(v)<=CHUNK_BYTES||depth>40)return [v];
  if(Array.isArray(v)){
   const out:unknown[]=[];let batch:unknown[]=[];
   for(const item of v){
    if(bytes(item)>CHUNK_BYTES){
     if(batch.length){out.push(batch);batch=[];}
     for(const piece of split(item,depth+1))out.push([piece]);
    }else if(batch.length&&bytes([...batch,item])>CHUNK_BYTES){out.push(batch);batch=[item];}
    else batch.push(item);
   }
   if(batch.length)out.push(batch);
   return out;
  }
  if(v&&typeof v==="object"){
   const out:unknown[]=[];let batch:Record<string,unknown>={};
   for(const [key,child] of Object.entries(v)){
    const leaf={[key]:child};
    if(bytes(leaf)>CHUNK_BYTES){
     if(Object.keys(batch).length){out.push(batch);batch={};}
     for(const piece of split(child,depth+1))out.push({[key]:piece});
    }else if(Object.keys(batch).length&&bytes({...batch,[key]:child})>CHUNK_BYTES){
     out.push(batch);batch=leaf;
    }else batch[key]=child;
   }
   if(Object.keys(batch).length)out.push(batch);
   return out;
  }
  return [v];
 };
 return split(raw,0);
}
export type ToastRawSampleResult={captured:number;skipped:boolean;failed:number;endpoints?:{endpoint:string;status:number|null;count:number}[];reason?:"invalid_request"|"no_location"|"busy"|"cooldown"|"db_error"|"missing_hash_key"|"lease_lost";};
const skip=(reason:NonNullable<ToastRawSampleResult["reason"]>,failed=0):ToastRawSampleResult=>({captured:0,skipped:true,failed,reason});
export async function claimToastRawSample(db:Pick<SupabaseClient,"rpc">,businessId:string,restaurantGuid:string,businessDate:string){
 const {data,error}=await db.rpc("toast_claim_raw_sample",{p_business_id:businessId,p_restaurant_guid:restaurantGuid,p_business_date:businessDate});
 if(error)throw new ToastApiError("unavailable");return data===true;
}
function pathFor(s:Entry,day:string,guid:string,id?:string,page=1,token?:string,window?:{start:Date;end:Date}){
 let path=s.path.replace(/\{(?:guid|employeeId|shiftId|timeEntryId|jobId|restaurantGUID|managementGroupGUID|reportRequestGuid)\}/g,id??guid);
 const params=new URLSearchParams();
 if(s.scope==="date")
  params.set(s.endpoint==="orders/v2/payments"?"paidBusinessDate":"businessDate",day.replaceAll("-",""));
 if(s.scope==="window"){
  const start=window?.start??new Date(day+"T00:00:00Z");
  const end=window?.end??new Date(start.getTime()+86400000);
  params.set("startDate",decodeURIComponent(toToastTimestamp(start)));
  params.set("endDate",decodeURIComponent(toToastTimestamp(end)));
 }
 if(s.page&&s.endpoint==="orders/v2/ordersBulk"){
  params.set("pageSize",String(PAGE_SIZE));params.set("page",String(page));
 }else if(s.page){
  if(s.endpoint==="partners/v1/connectedRestaurants")params.set("pageSize",String(PAGE_SIZE));
  if(token)params.set("pageToken",token);
 }
 if(params.size)path+="?"+params.toString();
 return path;
}
function discoveredIds(data:unknown):string[]{
 const result=new Set<string>();
 const visit=(v:unknown,depth:number)=>{
  if(depth>12)return;
  if(Array.isArray(v)){for(const item of v)visit(item,depth+1);return;}
  if(!v||typeof v!=="object"){
   if(typeof v==="string"&&GUID.safeParse(v).success)result.add(v);
   return;
  }
  const r=v as Record<string,unknown>;
  for(const k of ["guid","orderGuid","paymentGuid","id"]){
   const val=r[k];if(typeof val==="string"&&GUID.safeParse(val).success)result.add(val);
  }
 };
 visit(data,0);return [...result];
}
export async function captureToastRawSample(businessId:string,businessDate:string,
 db:SupabaseClient=createAdminSupabaseClient(),maxRuntimeMs=27*60*1000):Promise<ToastRawSampleResult>{
 if(!GUID.safeParse(businessId).success||!ISO.safeParse(businessDate).success||
 businessDate>new Date().toISOString().slice(0,10))return skip("invalid_request");
 const secret=process.env.TOAST_CUSTOMER_HASH_KEY;
 if(!secret||secret.length<32)return skip("missing_hash_key");
 const hashKey=createHmac("sha256",secret).update(businessId).digest("hex");
 let captured=0,failed=0,leaseNonce:string|null=null,reason:ToastRawSampleResult["reason"];
 const captureId=randomUUID();
 const summaries=new Map<string,{status:number|null;count:number}>();
 try{
  const {data:mappings,error}=await db.from("toast_location_mappings").select("restaurant_guid,toast_time_zone,closeout_hour")
   .eq("business_id",businessId).not("verified_at","is",null)
   .order("restaurant_guid",{ascending:true}).limit(1);
  if(error)return skip("db_error",1);
  if(!mappings?.length)return skip("no_location");
  const guid=String(mappings[0].restaurant_guid);
  const timeZone=typeof mappings[0].toast_time_zone==="string"?mappings[0].toast_time_zone:"UTC";
  const closeout=Number.isInteger(mappings[0].closeout_hour)?mappings[0].closeout_hour:0;
  const clock=String(closeout).padStart(2,"0")+":00:00";
  const dayStart=fromZonedTime(businessDate+"T"+clock,timeZone);
  const nextDate=new Date(businessDate+"T12:00:00Z");
  nextDate.setUTCDate(nextDate.getUTCDate()+1);
  const dayEnd=fromZonedTime(nextDate.toISOString().slice(0,10)+"T"+clock,timeZone);
  const businessWindow={start:dayStart,end:dayEnd};
  const acquired=await db.rpc("toast_acquire_lease",{p_business_id:businessId,p_restaurant_guid:guid,p_seconds:290});
  if(acquired.error)return skip("db_error",1);
  if(!acquired.data)return skip("busy");
  leaseNonce=String(acquired.data);
  if(!await claimToastRawSample(db,businessId,guid,businessDate))return skip("cooldown");
  const client=createToastClient(db,businessId);
  const deadlineAt=Date.now()+Math.max(60000,Math.min(27*60*1000,maxRuntimeMs));
  const analytics=createToastAnalyticsClient(db,businessId,deadlineAt);
  let lastRenew=Date.now();
  const known=new Map<string,Set<string>>();
  try{
   const {data:analyticsCredentials}=await db.from("toast_analytics_credentials")
    .select("management_group_guid").eq("business_id",businessId).maybeSingle();
   const group=analyticsCredentials?.management_group_guid;
   if(typeof group==="string"&&GUID.safeParse(group).success)
    known.set("__management_group__",new Set([group]));
  }catch{/* A missing Analytics connection is recorded by its GET operations. */}
  // Reuse only pre-existing Analytics report identifiers; never POST to create a report.
  try{
   const {data:jobs}=await db.from("toast_analytics_jobs").select("report_request_guid")
    .eq("business_id",businessId).eq("restaurant_guid",guid)
    .eq("business_date",businessDate).limit(20);
   for(const job of jobs??[]){
    const id=job.report_request_guid;
    if(typeof id==="string"&&GUID.safeParse(id).success){
     const found=known.get("__era_report__")??new Set<string>();
     found.add(id);known.set("__era_report__",found);
    }
   }
  }catch{/* Missing optional Analytics configuration is recorded per endpoint. */}
  const hold=async()=>{
   if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");
   if(Date.now()-lastRenew>120000){
    const r=await db.rpc("toast_renew_raw_sample_lease",{p_nonce:leaseNonce,p_seconds:290});
    if(r.error||r.data!==true){reason="lease_lost";throw new Error("lease_lost");}
    lastRenew=Date.now();
   }
  };
  const leaseLost=()=>reason==="lease_lost";
  const pace=async()=>{await hold();}; // Client enforces Toast's shared rate budget and endpoint-specific pacing.
  const save=async(s:Entry,raw:unknown,status:number|null,page:number|null,
    code:string|null=null,message:string|null=null)=>{
   const safe=redactToastRaw(raw,0,"",hashKey,"",s.endpoint)??{};
   const parts=chunks(safe);
   const root=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Record<string,unknown>:null;
   const count=code?0:Array.isArray(raw)?raw.length:
    Array.isArray(root?.data)?root.data.length:
    Array.isArray(root?.results)?root.results.length:
    Array.isArray(root?.menus)?root.menus.length:1;
   const old=summaries.get(s.endpoint);
   summaries.set(s.endpoint,{status:status??old?.status??null,count:(old?.count??0)+count});
   for(let i=0;i<parts.length;i++){
    await hold();
    const piece=parts[i];
    const {error:err}=await db.from("toast_raw_samples").insert({
     business_id:businessId,restaurant_guid:guid,business_date:businessDate,
     endpoint:s.endpoint,doc_url:s.doc,capture_id:captureId,page_number:page===null?null:page*1000+i,
     http_status:status,item_count:i===0?count:0,
     sample:piece,field_paths:toastFieldPaths(piece),
     identifier_counts:i===0?identifierCounts(raw):{},error_code:code,error_message:message
    });
    if(err)failed++;else captured++;
   }
  };
  for(const s of TOAST_READ_ENDPOINTS){
   if(leaseLost())break;
   if(s.scope==="unsupported"){
    await save(s,{},null,null,"method_not_get","This documented operation requires a non-GET method");
    continue;
   }
   const ids=s.scope==="id"?[...(known.get(s.source??"")??[])]:[undefined];
   if(!ids.length){await save(s,{},null,null,"missing_resource_guid","No eligible identifier for GET");continue;}
   for(const id of ids){
    let nextToken:string|undefined;
    const seenTokens=new Set<string>();
    for(let page=1;page<=(s.page?PAGE_CAP:1);page++){
     try{
      await pace();
      let http=200;
      let token:string|null=null;
      const requestPath=pathFor(s,businessDate,guid,id,page,nextToken,businessWindow);
      const raw=s.endpoint.startsWith("era/v1/")?
        await analytics.getRaw(requestPath).then(result=>{http=result.status;return result.data;}):
        await client.request(requestPath,guid,z.unknown(),
         {deadlineAt,onResponse:info=>{http=info.status;token=info.nextPageToken;}});
      const obj=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Record<string,unknown>:null;
      const list=Array.isArray(raw)?raw:Array.isArray(obj?.results)?obj.results as unknown[]:
        Array.isArray(obj?.data)?obj.data as unknown[]:undefined;
      const set=known.get(s.endpoint)??new Set<string>();
      if(s.endpoint==="orders/v2/payments"&&list){
       for(const item of list)if(typeof item==="string"&&GUID.safeParse(item).success)set.add(item);
      }else if(list)for(const item of list)for(const found of discoveredIds(item))set.add(found);
      known.set(s.endpoint,set);
      if(s.endpoint==="partners/v1/restaurants"&&list){
       const groups=known.get("__management_group__")??new Set<string>();
       for(const item of list){
        if(item&&typeof item==="object"){
         const g=(item as Record<string,unknown>).managementGroupGuid;
         if(typeof g==="string"&&GUID.safeParse(g).success)groups.add(g);
        }
       }
       known.set("__management_group__",groups);
      }
      await save(s,raw,http,s.page?page:1);
      if(!s.page)break;
      if(s.endpoint==="orders/v2/ordersBulk"){
       if(!list||list.length<PAGE_SIZE)break;
      }else{
       const next=token??(typeof obj?.nextPageToken==="string"?obj.nextPageToken:null);
       if(!next||seenTokens.has(next))break;
       seenTokens.add(next);nextToken=next;
      }
      if(page===PAGE_CAP)await save(s,{},null,page,"page_cap","Maximum 20 pages reached");
     }catch(e){
      if(leaseLost())break;
      const status=e instanceof ToastApiError?e.status??null:null;
      const code=status===204?"no_content":e instanceof ToastApiError?e.toastCode??e.category:"unavailable";
      const message=e instanceof ToastApiError?e.toastMessage??e.category:"unavailable";
      await save(s,{},status,s.page?page:1,code,message);
      break;
     }
    }
    if(leaseLost())break;
   }
  }
 }catch(e){
  if(reason!=="lease_lost")reason="db_error";
  failed++;
 }finally{
  if(leaseNonce)try{const released=await db.rpc("toast_release_lease",{p_nonce:leaseNonce});if(released.error)failed++;}catch{failed++;}
 }
 return {captured,failed,skipped:captured===0,
  endpoints:[...summaries].map(([endpoint,v])=>({endpoint,status:v.status,count:v.count})),
  ...(reason?{reason}:{})};
}
