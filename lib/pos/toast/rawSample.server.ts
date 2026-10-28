import "server-only";
import {createHmac,randomUUID} from "node:crypto";
import type {SupabaseClient} from "@supabase/supabase-js";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {z} from "zod";
import {fromZonedTime} from "date-fns-tz";
import {createToastClient,GUID,ToastApiError,toToastTimestamp} from "./client";
import {createToastAnalyticsClient} from "./analyticsClient";

type Scope="date"|"window"|"none"|"restaurant"|"id"|"unsupported"|"era_request";
type Entry={endpoint:string;path:string;doc:string;scope:Scope;page?:boolean;source?:string};
const doc=(family:string,operation:string)=>"https://doc.toasttab.com/openapi/"+family+"/operation/"+operation;
const entry=(endpoint:string,path:string,family:string,operation:string,scope:Scope="none",page=false,source?:string):Entry=>
 ({endpoint,path,doc:doc(family,operation),scope,page,source});
/** Explicit inventory; each operation is attempted or recorded as a prerequisite/method gap. */
/** 88 GET operations, nine ERA requests, five no-GET family rows (Toast specs). */
export const TOAST_READ_ENDPOINTS:readonly Entry[]=[{"endpoint":"authentication/no_get_operations","path":"/","doc":"https://doc.toasttab.com/openapi/authentication/overview/","scope":"unsupported"},{"endpoint":"creditcards/no_get_operations","path":"/","doc":"https://doc.toasttab.com/openapi/creditcards/overview/","scope":"unsupported"},{"endpoint":"giftcards/no_get_operations","path":"/","doc":"https://doc.toasttab.com/openapi/giftcards/overview/","scope":"unsupported"},{"endpoint":"loyalty/no_get_operations","path":"/","doc":"https://doc.toasttab.com/openapi/loyalty/overview/","scope":"unsupported"},{"endpoint":"tender/no_get_operations","path":"/","doc":"https://doc.toasttab.com/openapi/tender/overview/","scope":"unsupported"},{"endpoint":"orders/v2/ordersBulk","path":"/orders/v2/ordersBulk","doc":"https://doc.toasttab.com/openapi/orders/operation/ordersBulkGet/","scope":"date","page":true},{"endpoint":"orders/v2/payments","path":"/orders/v2/payments","doc":"https://doc.toasttab.com/openapi/orders/operation/paymentsGet/","scope":"date"},{"endpoint":"orders/v2/orders","path":"/orders/v2/orders","doc":"https://doc.toasttab.com/openapi/orders/operation/ordersGet/","scope":"date"},{"endpoint":"menus/v2/menus","path":"/menus/v2/menus","doc":"https://doc.toasttab.com/openapi/menus/operation/menusGet/","scope":"none"},{"endpoint":"menus/v2/metadata","path":"/menus/v2/metadata","doc":"https://doc.toasttab.com/openapi/menus/operation/metadataGet/","scope":"none"},{"endpoint":"menus/v3/menus","path":"/menus/v3/menus","doc":"https://doc.toasttab.com/openapi/menusv3/operation/menusGet/","scope":"none"},{"endpoint":"menus/v3/metadata","path":"/menus/v3/metadata","doc":"https://doc.toasttab.com/openapi/menusv3/operation/metadataGet/","scope":"none"},{"endpoint":"config/v2/alternatePaymentTypes","path":"/config/v2/alternatePaymentTypes","doc":"https://doc.toasttab.com/openapi/configuration/operation/alternatePaymentTypesGet/","scope":"none","page":true},{"endpoint":"config/v2/breakTypes","path":"/config/v2/breakTypes","doc":"https://doc.toasttab.com/openapi/configuration/operation/breakTypesGet/","scope":"none","page":true},{"endpoint":"config/v2/cashDrawers","path":"/config/v2/cashDrawers","doc":"https://doc.toasttab.com/openapi/configuration/operation/cashDrawersGet/","scope":"none","page":true},{"endpoint":"config/v2/diningOptions","path":"/config/v2/diningOptions","doc":"https://doc.toasttab.com/openapi/configuration/operation/diningOptionsGet/","scope":"none","page":true},{"endpoint":"config/v2/discounts","path":"/config/v2/discounts","doc":"https://doc.toasttab.com/openapi/configuration/operation/discountsGet/","scope":"none","page":true},{"endpoint":"config/v2/menuGroups","path":"/config/v2/menuGroups","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuGroupsGet/","scope":"none","page":true},{"endpoint":"config/v2/menuItems","path":"/config/v2/menuItems","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuItemsGet/","scope":"none","page":true},{"endpoint":"config/v2/menuOptionGroups","path":"/config/v2/menuOptionGroups","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuOptionGroupsGet/","scope":"none","page":true},{"endpoint":"config/v2/menus","path":"/config/v2/menus","doc":"https://doc.toasttab.com/openapi/configuration/operation/menusGet/","scope":"none","page":true},{"endpoint":"config/v2/noSaleReasons","path":"/config/v2/noSaleReasons","doc":"https://doc.toasttab.com/openapi/configuration/operation/noSaleReasonsGet/","scope":"none","page":true},{"endpoint":"config/v2/payoutReasons","path":"/config/v2/payoutReasons","doc":"https://doc.toasttab.com/openapi/configuration/operation/payoutReasonsGet/","scope":"none","page":true},{"endpoint":"config/v2/preModifierGroups","path":"/config/v2/preModifierGroups","doc":"https://doc.toasttab.com/openapi/configuration/operation/preModifierGroupsGet/","scope":"none","page":true},{"endpoint":"config/v2/preModifiers","path":"/config/v2/preModifiers","doc":"https://doc.toasttab.com/openapi/configuration/operation/preModifiersGet/","scope":"none","page":true},{"endpoint":"config/v2/priceGroups","path":"/config/v2/priceGroups","doc":"https://doc.toasttab.com/openapi/configuration/operation/priceGroupsGet/","scope":"none","page":true},{"endpoint":"config/v2/printers","path":"/config/v2/printers","doc":"https://doc.toasttab.com/openapi/configuration/operation/printersGet/","scope":"none","page":true},{"endpoint":"config/v2/restaurantServices","path":"/config/v2/restaurantServices","doc":"https://doc.toasttab.com/openapi/configuration/operation/restaurantServicesGet/","scope":"none","page":true},{"endpoint":"config/v2/revenueCenters","path":"/config/v2/revenueCenters","doc":"https://doc.toasttab.com/openapi/configuration/operation/revenueCentersGet/","scope":"none","page":true},{"endpoint":"config/v2/salesCategories","path":"/config/v2/salesCategories","doc":"https://doc.toasttab.com/openapi/configuration/operation/salesCategoriesGet/","scope":"none","page":true},{"endpoint":"config/v2/serviceAreas","path":"/config/v2/serviceAreas","doc":"https://doc.toasttab.com/openapi/configuration/operation/serviceAreasGet/","scope":"none","page":true},{"endpoint":"config/v2/serviceCharges","path":"/config/v2/serviceCharges","doc":"https://doc.toasttab.com/openapi/configuration/operation/serviceChargesGet/","scope":"none","page":true},{"endpoint":"config/v2/tables","path":"/config/v2/tables","doc":"https://doc.toasttab.com/openapi/configuration/operation/tablesGet/","scope":"none","page":true},{"endpoint":"config/v2/taxRates","path":"/config/v2/taxRates","doc":"https://doc.toasttab.com/openapi/configuration/operation/taxRatesGet/","scope":"none","page":true},{"endpoint":"config/v2/tipWithholding","path":"/config/v2/tipWithholding","doc":"https://doc.toasttab.com/openapi/configuration/operation/tipWithholdingGet/","scope":"none","page":true},{"endpoint":"config/v2/voidReasons","path":"/config/v2/voidReasons","doc":"https://doc.toasttab.com/openapi/configuration/operation/voidReasonsGet/","scope":"none","page":true},{"endpoint":"labor/v1/employees","path":"/labor/v1/employees","doc":"https://doc.toasttab.com/openapi/labor/operation/employeesGet/","scope":"none"},{"endpoint":"labor/v1/jobs","path":"/labor/v1/jobs","doc":"https://doc.toasttab.com/openapi/labor/operation/jobsGet/","scope":"none"},{"endpoint":"labor/v1/shifts","path":"/labor/v1/shifts","doc":"https://doc.toasttab.com/openapi/labor/operation/shiftsGet/","scope":"window"},{"endpoint":"labor/v1/timeEntries","path":"/labor/v1/timeEntries","doc":"https://doc.toasttab.com/openapi/labor/operation/timeEntriesGet/","scope":"window"},{"endpoint":"cashmgmt/v1/deposits","path":"/cashmgmt/v1/deposits","doc":"https://doc.toasttab.com/openapi/cashmanagement/operation/depositsGet/","scope":"date"},{"endpoint":"cashmgmt/v1/entries","path":"/cashmgmt/v1/entries","doc":"https://doc.toasttab.com/openapi/cashmanagement/operation/entriesGet/","scope":"date"},{"endpoint":"stock/v1/inventory","path":"/stock/v1/inventory","doc":"https://doc.toasttab.com/openapi/stock/operation/getInventory/","scope":"none"},{"endpoint":"kitchen/v1/export/itemFulfillments","path":"/kitchen/v1/export/itemFulfillments","doc":"https://doc.toasttab.com/openapi/kitchen/operation/itemFulfillmentsGet/","scope":"date"},{"endpoint":"kitchen/v1/published/prepStations","path":"/kitchen/v1/published/prepStations","doc":"https://doc.toasttab.com/openapi/kitchen/operation/prepStationsGet/","scope":"none","page":true},{"endpoint":"partners/v1/connectedRestaurants","path":"/partners/v1/connectedRestaurants","doc":"https://doc.toasttab.com/openapi/partners/operation/connectedRestaurantsGet/","scope":"none","page":true},{"endpoint":"partners/v1/restaurants","path":"/partners/v1/restaurants","doc":"https://doc.toasttab.com/openapi/partners/operation/restaurantsGet/","scope":"none"},{"endpoint":"packaging/v1/published/packagingConfig","path":"/packaging/v1/published/packagingConfig","doc":"https://doc.toasttab.com/openapi/packaging/operation/getPackagingConfig/","scope":"none"},{"endpoint":"restaurant-availability/v1/availability","path":"/restaurant-availability/v1/availability","doc":"https://doc.toasttab.com/openapi/rx.availability.service/operation/availabilityGet/","scope":"none"},{"endpoint":"ordermgmt-config/v1/published/orderingSchedule","path":"/ordermgmt-config/v1/published/orderingSchedule","doc":"https://doc.toasttab.com/openapi/ordermgmt.configuration/operation/orderingScheduleGet/","scope":"none"},{"endpoint":"device-details/v1/device-info","path":"/device-details/v1/device-info","doc":"https://doc.toasttab.com/openapi/devicedetails/operation/getDeviceInfo/","scope":"none"},{"endpoint":"restaurants/v1/restaurants/{restaurantGUID}","path":"/restaurants/v1/restaurants/{restaurantGUID}","doc":"https://doc.toasttab.com/openapi/restaurants/operation/restaurantsRestaurantGuidGet/","scope":"restaurant"},{"endpoint":"orders/v2/payments/{guid}","path":"/orders/v2/payments/{guid}","doc":"https://doc.toasttab.com/openapi/orders/operation/paymentsGuidGet/","scope":"id","source":"orders/v2/payments"},{"endpoint":"orders/v2/orders/{guid}","path":"/orders/v2/orders/{guid}","doc":"https://doc.toasttab.com/openapi/orders/operation/ordersGuidGet/","scope":"id","source":"orders/v2/ordersBulk"},{"endpoint":"config/v2/alternatePaymentTypes/{guid}","path":"/config/v2/alternatePaymentTypes/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/alternatePaymentTypesGuidGet/","scope":"id","source":"config/v2/alternatePaymentTypes"},{"endpoint":"config/v2/breakTypes/{guid}","path":"/config/v2/breakTypes/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/breakTypesGuidGet/","scope":"id","source":"config/v2/breakTypes"},{"endpoint":"config/v2/cashDrawers/{guid}","path":"/config/v2/cashDrawers/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/cashDrawersGuidGet/","scope":"id","source":"config/v2/cashDrawers"},{"endpoint":"config/v2/diningOptions/{guid}","path":"/config/v2/diningOptions/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/diningOptionsGuidGet/","scope":"id","source":"config/v2/diningOptions"},{"endpoint":"config/v2/discounts/{guid}","path":"/config/v2/discounts/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/discountsGuidGet/","scope":"id","source":"config/v2/discounts"},{"endpoint":"config/v2/menuGroups/{guid}","path":"/config/v2/menuGroups/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuGroupsGuidGet/","scope":"id","source":"config/v2/menuGroups"},{"endpoint":"config/v2/menuItems/{guid}","path":"/config/v2/menuItems/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuItemsGuidGet/","scope":"id","source":"config/v2/menuItems"},{"endpoint":"config/v2/menuOptionGroups/{guid}","path":"/config/v2/menuOptionGroups/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/menuOptionGroupsGuidGet/","scope":"id","source":"config/v2/menuOptionGroups"},{"endpoint":"config/v2/menus/{guid}","path":"/config/v2/menus/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/menusGuidGet/","scope":"id","source":"config/v2/menus"},{"endpoint":"config/v2/noSaleReasons/{guid}","path":"/config/v2/noSaleReasons/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/noSaleReasonsGuidGet/","scope":"id","source":"config/v2/noSaleReasons"},{"endpoint":"config/v2/payoutReasons/{guid}","path":"/config/v2/payoutReasons/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/payoutReasonsGuidGet/","scope":"id","source":"config/v2/payoutReasons"},{"endpoint":"config/v2/preModifierGroups/{guid}","path":"/config/v2/preModifierGroups/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/preModifierGroupsGuidGet/","scope":"id","source":"config/v2/preModifierGroups"},{"endpoint":"config/v2/preModifiers/{guid}","path":"/config/v2/preModifiers/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/preModifiersGuidGet/","scope":"id","source":"config/v2/preModifiers"},{"endpoint":"config/v2/priceGroups/{guid}","path":"/config/v2/priceGroups/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/priceGroupsGuidGet/","scope":"id","source":"config/v2/priceGroups"},{"endpoint":"config/v2/printers/{guid}","path":"/config/v2/printers/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/printersGuidGet/","scope":"id","source":"config/v2/printers"},{"endpoint":"config/v2/restaurantServices/{guid}","path":"/config/v2/restaurantServices/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/restaurantServicesGuidGet/","scope":"id","source":"config/v2/restaurantServices"},{"endpoint":"config/v2/revenueCenters/{guid}","path":"/config/v2/revenueCenters/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/revenueCentersGuidGet/","scope":"id","source":"config/v2/revenueCenters"},{"endpoint":"config/v2/salesCategories/{guid}","path":"/config/v2/salesCategories/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/salesCategoriesGuidGet/","scope":"id","source":"config/v2/salesCategories"},{"endpoint":"config/v2/serviceAreas/{guid}","path":"/config/v2/serviceAreas/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/serviceAreasGuidGet/","scope":"id","source":"config/v2/serviceAreas"},{"endpoint":"config/v2/serviceCharges/{guid}","path":"/config/v2/serviceCharges/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/serviceChargesGuidGet/","scope":"id","source":"config/v2/serviceCharges"},{"endpoint":"config/v2/tables/{guid}","path":"/config/v2/tables/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/tablesGuidGet/","scope":"id","source":"config/v2/tables"},{"endpoint":"config/v2/taxRates/{guid}","path":"/config/v2/taxRates/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/taxRatesGuidGet/","scope":"id","source":"config/v2/taxRates"},{"endpoint":"config/v2/voidReasons/{guid}","path":"/config/v2/voidReasons/{guid}","doc":"https://doc.toasttab.com/openapi/configuration/operation/voidReasonsGuidGet/","scope":"id","source":"config/v2/voidReasons"},{"endpoint":"labor/v1/employees/{employeeId}","path":"/labor/v1/employees/{employeeId}","doc":"https://doc.toasttab.com/openapi/labor/operation/employeesEmployeeIdGet/","scope":"id","source":"labor/v1/employees"},{"endpoint":"labor/v1/jobs/{jobId}","path":"/labor/v1/jobs/{jobId}","doc":"https://doc.toasttab.com/openapi/labor/operation/jobsJobIdGet/","scope":"id","source":"labor/v1/jobs"},{"endpoint":"labor/v1/shifts/{shiftId}","path":"/labor/v1/shifts/{shiftId}","doc":"https://doc.toasttab.com/openapi/labor/operation/shiftsShiftIdGet/","scope":"id","source":"labor/v1/shifts"},{"endpoint":"labor/v1/timeEntries/{timeEntryId}","path":"/labor/v1/timeEntries/{timeEntryId}","doc":"https://doc.toasttab.com/openapi/labor/operation/timeEntriesTimeEntryIdGet/","scope":"id","source":"labor/v1/timeEntries"},{"endpoint":"kitchen/v1/published/prepStations/{guid}","path":"/kitchen/v1/published/prepStations/{guid}","doc":"https://doc.toasttab.com/openapi/kitchen/operation/prepStationsGuidGet/","scope":"id","source":"kitchen/v1/published/prepStations"},{"endpoint":"restaurants/v1/groups/{managementGroupGUID}/restaurants","path":"/restaurants/v1/groups/{managementGroupGUID}/restaurants","doc":"https://doc.toasttab.com/openapi/restaurants/operation/groupsManagementGroupGuidRestaurantsGet/","scope":"id","source":"__management_group__"},{"endpoint":"era/v1/metrics/day","path":"/era/v1/metrics/day","doc":"https://doc.toasttab.com/openapi/analytics/operation/postMetricsReportingDataSpecificTimeRangeRequest/","scope":"era_request"},{"endpoint":"era/v1/metrics","path":"/era/v1/metrics","doc":"https://doc.toasttab.com/openapi/analytics/operation/postMetricsReportingDataCustomTimeRangeRequest/","scope":"era_request"},{"endpoint":"era/v1/check/day","path":"/era/v1/check/day","doc":"https://doc.toasttab.com/openapi/analytics/operation/postCheckReportingDataSpecificTimeRangeRequest/","scope":"era_request"},{"endpoint":"era/v1/labor/day","path":"/era/v1/labor/day","doc":"https://doc.toasttab.com/openapi/analytics/operation/postLaborReportingDataSpecificTimeRangeRequest/","scope":"era_request"},{"endpoint":"era/v1/menu/day","path":"/era/v1/menu/day","doc":"https://doc.toasttab.com/openapi/analytics/operation/postMenuReportSpecificTimeRange/","scope":"era_request"},{"endpoint":"era/v1/payout/day","path":"/era/v1/payout/day","doc":"https://doc.toasttab.com/openapi/analytics/operation/postPayoutReportSettledDateSpecificTimeRange/","scope":"era_request"},{"endpoint":"era/v1/payout/payments/day","path":"/era/v1/payout/payments/day","doc":"https://doc.toasttab.com/openapi/analytics/operation/postPayoutReportPaymentsSpecificTimeRange/","scope":"era_request"},{"endpoint":"era/v1/payout/sales-date/day","path":"/era/v1/payout/sales-date/day","doc":"https://doc.toasttab.com/openapi/analytics/operation/postPayoutReportSalesDateSpecificTimeRange/","scope":"era_request"},{"endpoint":"era/v1/guest/payments/day","path":"/era/v1/guest/payments/day","doc":"https://doc.toasttab.com/openapi/analytics/operation/postGuestReportPaymentDateSpecificTimeRange/","scope":"era_request"},{"endpoint":"era/v1/restaurants-information","path":"/era/v1/restaurants-information","doc":"https://doc.toasttab.com/openapi/analytics/operation/getManagementGroupRestaurantsInformation/","scope":"none"},{"endpoint":"era/v1/check/{reportRequestGuid}","path":"/era/v1/check/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getCheckReportingData/","scope":"id","source":"era/v1/check/day"},{"endpoint":"era/v1/guest/payments/{reportRequestGuid}","path":"/era/v1/guest/payments/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getGuestByPaymentDateReportingData/","scope":"id","source":"era/v1/guest/payments/day"},{"endpoint":"era/v1/labor/{reportRequestGuid}","path":"/era/v1/labor/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getLaborReportingData/","scope":"id","source":"era/v1/labor/day"},{"endpoint":"era/v1/menu/{reportRequestGuid}","path":"/era/v1/menu/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getMenuReportingData/","scope":"id","source":"era/v1/menu/day"},{"endpoint":"era/v1/metrics/{reportRequestGuid}","path":"/era/v1/metrics/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getMetricsReportingData/","scope":"id","source":"era/v1/metrics"},{"endpoint":"era/v1/metrics/{timeRange}/{reportRequestGuid}","path":"/era/v1/metrics/{timeRange}/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getMetricsReportingDataSpecificTimeRange/","scope":"id","source":"era/v1/metrics/day"},{"endpoint":"era/v1/payout/{reportRequestGuid}","path":"/era/v1/payout/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getPayoutSettledDateReportingData/","scope":"id","source":"era/v1/payout/day"},{"endpoint":"era/v1/payout/payments/{reportRequestGuid}","path":"/era/v1/payout/payments/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getPayoutPaymentsReportingData/","scope":"id","source":"era/v1/payout/payments/day"},{"endpoint":"era/v1/payout/sales-date/{reportRequestGuid}","path":"/era/v1/payout/sales-date/{reportRequestGuid}","doc":"https://doc.toasttab.com/openapi/analytics/operation/getPayoutSalesDateReportingData/","scope":"id","source":"era/v1/payout/sales-date/day"}];
const ISO=z.iso.date();
const PAGE_CAP=20;
const PAGE_SIZE=100;
const CHUNK_BYTES=180000;
// Drop personal, payment-credential and arbitrary note fields. Do not use
// broad "orders/checks/payments" context allowlists: they lose business data.
const PERSONAL_FIELD=/(?:^name$|^displayName$|^nickname$|^firstName$|^lastName$|^fullName$|^chosenName$)/i;
const PERSONAL_PARENT=/(?:^customer$|^customerInfo$|^customerDetails$|^guest$|^guestInfo$|^loyalty$|^loyaltyAccount$|^patron$|^card$|^cardInfo$|^cardDetails$|^creditCard$|^paymentCard$|^cardholder$|^person$|^recipient$|^buyer$|^purchaser$|^payer$|^contact$|^deliveryInfo$|^billing$|^shipping$)/i;
const CONTACT_FIELD=/(?:email|phone|mobile|fax|street|address|postal|zipCode|latitude|longitude|^lat$|^lon$|^lng$|ipAddress|birth|^firstName$|^lastName$|^fullName$|^chosenName$|^(?:customer|guest|cardholder|employee|server|cashier|recipient|buyer|purchaser|payer|patron)(?:First|Last|Full|Chosen)?Name$)/i;
const PERSONAL_LOCATION=/^(?:city|country|state|suite|unit)$/i;
const CARD_SECRET=/(?:cardNumber|cardLast4|lastFour|last4|first5|firstFive|first6|firstSix|pan$|cvv|cvc|magstripe|trackData|expiry|expiration|expireDate|cardholderName|cardName|networkId)/i;
const AUTH_SECRET=/(?:password|secret|authorization|token|apiKey|credential|sessionToken|signature|passcode|pin$|routingNumber|accountNumber|deviceId)/i;
const FREEFORM=/(?:notes?|memo|comment|message|instructions?|^text$|^tabName$|receiptText|^description$)/i;
const CUSTOMER_ID=/(?:^customer(?:Id|Guid|Identifier|AccountId|AccountGuid|Number|ExternalId)$|^guest(?:Id|Guid|Identifier)$|^loyalty(?:Id|Guid|Identifier|AccountId|AccountGuid|AccountNumber|CustomerId|CustomerGuid)$|^card(?:Id|Guid|Fingerprint|TokenId|NumberIdentifier)$|^creditCard(?:Id|Guid|Fingerprint)$|^giftCard(?:Id|Guid|Fingerprint)$|^cardPaymentId$|^paymentCardId$|^cardTokenId$|^networkTransactionIdentifier$|^tenderTransactionGuid$|^maskedLoyaltyIdentifier$)/i;
const KEY=/^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
const isPersonalContext=(context:string)=>PERSONAL_PARENT.test(context);
const isSensitiveId=(key:string,context:string)=>CUSTOMER_ID.test(key)||
 /^(?:id|guid|referenceId|externalId|accountId|accountGuid|fingerprint|identifier|tokenId)$/i.test(key)&&
 /^(?:customer|customerInfo|customerDetails|guest|guestInfo|loyalty|loyaltyAccount|patron|card|cardInfo|cardDetails|giftCard|giftCardInfo|creditCard|paymentCard|cardholder)$/.test(context);
function safeString(s:string){
 return s.length<=100000 &&
 !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s) &&
 !/(?:\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\b\d{13,19}\b)/.test(s);
}
export function redactToastRaw(value:unknown,depth=0,key="",hashKey?:string,context="",scope=""):unknown{
 if(depth>32)return null;
 if(Array.isArray(value))return value.map(v=>redactToastRaw(v,depth+1,key,hashKey,context,scope));
 if(value&&typeof value==="object"){
  return Object.fromEntries(Object.entries(value as Record<string,unknown>)
   .filter(([k])=>KEY.test(k))
   .filter(([k])=>{
    if(isSensitiveId(k,context))return true;
    if(CONTACT_FIELD.test(k)||CARD_SECRET.test(k)||AUTH_SECRET.test(k)||isPersonalContext(context)&&PERSONAL_LOCATION.test(k))return false;
    if(FREEFORM.test(k)&&!(k==="description"&&/^(?:menus|config)\//.test(scope)))return false;
    // "name" on a check/order/payment is the guest tab/payer name, not the
    // name of the menu item; nested selections/discounts/modifiers are retained.
    if(PERSONAL_FIELD.test(k)&&(/^(?:orders?|checks?|payments?|employee|staff|server|cashier)$/i.test(context)||isPersonalContext(context)))return false;
    return true;
   })
   .filter(([k,v])=>!isPersonalContext(context)||typeof v!=="string"||
    isSensitiveId(k,context)||/^(?:type|status|state|currency|cardType|cardEntryMode|jobTitle|jobCode|title|paymentStatus|source)$/i.test(k)||
    /(?:Date|Time|At|Timestamp)$/i.test(k))
   .map(([k,v])=>[k,redactToastRaw(v,depth+1,k,hashKey,k==="selections"||k==="discounts"||k==="modifiers"||k==="items"||k==="menuItems"?"":(PERSONAL_PARENT.test(k)||/^(?:giftCard|giftCardInfo|orders?|checks?|payments?|employee|staff|server|cashier)$/i.test(k))?k:context,scope)])
   .filter(([,v])=>v!==undefined));
 }
 if(isSensitiveId(key,context)){
  if(!hashKey)return undefined;
  if(typeof value!=="string"&&typeof value!=="number")return null;
  return "hmac:"+createHmac("sha256",hashKey).update(String(value)).digest("hex");
 }
 if(typeof value==="string"&&/^(?:customer|guest|loyalty|patron|cardholder|recipient|buyer|purchaser|payer|contact)$/i.test(key)){
  // Primitive personal fields may be names or identifiers; never persist raw.
  return GUID.safeParse(value).success&&hashKey?
   "hmac:"+createHmac("sha256",hashKey).update(value).digest("hex"):"[redacted]";
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
   if(isSensitiveId(k,path.split('.').at(-1)??'')){
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
export type ToastRawSampleResult={captured:number;skipped:boolean;failed:number;endpoints?:{endpoint:string;status:number|null;count:number}[];reason?:"invalid_request"|"no_location"|"busy"|"cooldown"|"db_error"|"missing_hash_key"|"lease_lost"|"partial";};
const skip=(reason:NonNullable<ToastRawSampleResult["reason"]>,failed=0):ToastRawSampleResult=>({captured:0,skipped:true,failed,reason});
export async function claimToastRawSample(db:Pick<SupabaseClient,"rpc">,businessId:string,restaurantGuid:string,businessDate:string){
 const {data,error}=await db.rpc("toast_claim_raw_sample",{p_business_id:businessId,p_restaurant_guid:restaurantGuid,p_business_date:businessDate});
 if(error)throw new ToastApiError("unavailable");return data===true;
}
function pathFor(s:Entry,day:string,guid:string,id?:string,page=1,token?:string,window?:{start:Date;end:Date},paymentDateField="paidBusinessDate"){
 let path=s.path.replace("{timeRange}","day").replace(/\{(?:guid|employeeId|shiftId|timeEntryId|jobId|restaurantGUID|managementGroupGUID|reportRequestGuid)\}/g,id??guid);
 const params=new URLSearchParams();
 if(s.scope==="date")
  params.set(s.endpoint==="orders/v2/payments"?paymentDateField:"businessDate",day.replaceAll("-",""));
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
 const captureId=randomUUID();
 let captured=0,failed=0,leaseNonce:string|null=null,reason:ToastRawSampleResult["reason"];
 let incompleteReason:"skipped_time_budget"|"skipped_interrupted"|"skipped_lease_lost"="skipped_interrupted";
 let finalize:undefined|(()=>Promise<void>);
 const summaries=new Map<string,{status:number|null;count:number}>();
 const incomplete=new Set<string>();
 // Run high-level GETs before potentially expensive per-GUID detail requests.
 const endpointOrder=[
  ...TOAST_READ_ENDPOINTS.filter(s=>s.scope==="unsupported"),
  ...TOAST_READ_ENDPOINTS.filter(s=>s.scope!=="unsupported"&&s.scope!=="id"),
  ...TOAST_READ_ENDPOINTS.filter(s=>s.scope==="id")
 ];
 try{
  const {data:mappings,error}=await db.from("toast_location_mappings")
   .select("restaurant_guid,toast_time_zone,closeout_hour").eq("business_id",businessId)
   .not("verified_at","is",null).order("restaurant_guid",{ascending:true}).limit(1);
  if(error)return skip("db_error",1);
  if(!mappings?.length)return skip("no_location");
  const guid=String(mappings[0].restaurant_guid);
  const acquired=await db.rpc("toast_acquire_raw_sample_lease",{
   p_business_id:businessId,p_restaurant_guid:guid,p_seconds:290
  });
  if(acquired.error)return skip("db_error",1);
  if(!acquired.data)return skip("busy");
  leaseNonce=String(acquired.data);
  if(!await claimToastRawSample(db,businessId,guid,businessDate))return skip("cooldown");

  // Durable baseline: if the worker exits unexpectedly, every endpoint still
  // has an evidence row in this capture, rather than inheriting stale success.
  const base=(s:Entry)=>({
   business_id:businessId,restaurant_guid:guid,business_date:businessDate,
   endpoint:s.endpoint,doc_url:s.doc,capture_id:captureId,
   page_number:null as number|null,http_status:null as number|null,item_count:0,
   sample:{},field_paths:[] as string[],identifier_counts:{},
   error_code:"not_attempted",error_message:"not_attempted"
  });
  const {error:seedError}=await db.from("toast_raw_samples").insert(endpointOrder.map(base));
  if(seedError)return skip("db_error",1);

  const timeZone=typeof mappings[0].toast_time_zone==="string"?mappings[0].toast_time_zone:"UTC";
  const closeout=Number.isInteger(mappings[0].closeout_hour)?mappings[0].closeout_hour:0;
  const clock=String(closeout).padStart(2,"0")+":00:00";
  const dayStart=fromZonedTime(businessDate+"T"+clock,timeZone);
  const nextDate=new Date(businessDate+"T12:00:00Z");
  nextDate.setUTCDate(nextDate.getUTCDate()+1);
  const dayEnd=fromZonedTime(nextDate.toISOString().slice(0,10)+"T"+clock,timeZone);
  const businessWindow={start:dayStart,end:dayEnd};
  const deadlineAt=Date.now()+Math.max(1000,Math.min(27*60*1000,maxRuntimeMs));
  const requestDeadlineAt=deadlineAt-20_000;
  const timeLow=()=>Date.now()>=requestDeadlineAt;
  const client=createToastClient(db,businessId);
  const analytics=createToastAnalyticsClient(db,businessId,requestDeadlineAt,true);
  let lastRenew=Date.now();
  const known=new Map<string,Set<string>>();
  try{
   const {data:analyticsCredentials}=await db.from("toast_analytics_credentials")
    .select("management_group_guid").eq("business_id",businessId).maybeSingle();
   const group=analyticsCredentials?.management_group_guid;
   if(typeof group==="string"&&GUID.safeParse(group).success)
    known.set("__management_group__",new Set([group]));
  }catch{/* Missing optional Analytics access is recorded for each ERA endpoint. */}
  const eraFailures=new Map<string,{status:number|null;code:string}>();
  const hold=async()=>{
   if(Date.now()>=deadlineAt)throw new ToastApiError("timeout");
   if(Date.now()-lastRenew>120000){
    const r=await db.rpc("toast_renew_raw_sample_lease",{p_nonce:leaseNonce,p_seconds:290});
    if(r.error||r.data!==true){reason="lease_lost";throw new ToastApiError("unavailable");}
    lastRenew=Date.now();
   }
  };
  const leaseLost=()=>reason==="lease_lost";
  const save=async(s:Entry,raw:unknown,status:number|null,page:number|null,
    code:string|null=null,message:string|null=null)=>{
   const rootContext=s.endpoint.startsWith("orders/v2/orders")?"orders":
    s.endpoint.startsWith("orders/v2/payments")||
    s.endpoint.startsWith("era/v1/guest/payments")?"payments":
    s.endpoint.startsWith("labor/v1/employees")?"employee":"";
   const safe=redactToastRaw(raw,0,"",hashKey,rootContext,s.endpoint)??{};
   const pieces=chunks(safe);
   const obj=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Record<string,unknown>:null;
   const count=code?0:Array.isArray(raw)?raw.length:
    Array.isArray(obj?.data)?obj.data.length:
    Array.isArray(obj?.results)?obj.results.length:
    Array.isArray(obj?.menus)?obj.menus.length:1;
   for(let i=0;i<pieces.length;i++){
    const piece=pieces[i];
    const {error:err}=await db.from("toast_raw_samples").insert({
     business_id:businessId,restaurant_guid:guid,business_date:businessDate,
     endpoint:s.endpoint,doc_url:s.doc,capture_id:captureId,
     page_number:page===null?null:page*1000+i,
     http_status:status,item_count:i===0?count:0,
     sample:piece,field_paths:toastFieldPaths(piece),
     identifier_counts:i===0?identifierCounts(raw):{},
     error_code:code,error_message:message
    });
    if(err){
     failed++;reason="partial";incomplete.add(s.endpoint);
     throw new Error("sample_write_failed");
    }
    captured++;
   }
   const old=summaries.get(s.endpoint);
   summaries.set(s.endpoint,{status:status??old?.status??null,count:(old?.count??0)+count});
  };
  finalize=async()=>{
   const needs=endpointOrder.filter(s=>!summaries.has(s.endpoint)||incomplete.has(s.endpoint));
   if(!needs.length)return;
   const rows=needs.map(s=>({...base(s),error_code:incompleteReason,error_message:incompleteReason}));
   const {error}=await db.from("toast_raw_samples").insert(rows);
   if(error){failed+=rows.length;return;} // The durable not_attempted seeds remain.
   captured+=rows.length;
   for(const s of needs)if(!summaries.has(s.endpoint))
    summaries.set(s.endpoint,{status:null,count:0});
  };
  const pollEra=async(path:string)=>{
   for(let attempt=0;attempt<4;attempt++){
    if(timeLow())throw new ToastApiError("timeout");
    const result=await analytics.getRaw(path);
    if(result.status!==202||attempt===3)return result;
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,Math.min(1000,requestDeadlineAt-Date.now()-1000))));
   }
   throw new ToastApiError("timeout");
  };
  endpointLoop:for(const [endpointIndex,s] of endpointOrder.entries()){
   if(leaseLost())break;
   if(s.scope!=="unsupported"&&timeLow()){
    reason="partial";incompleteReason="skipped_time_budget";break;
   }
   if(s.scope==="unsupported"){
    await save(s,{},null,null,"no_get_operations","No documented GET operations in this API family");
    continue;
   }
   if(s.scope==="era_request"){
    try{
     await hold();
     const requested=await analytics.requestRaw(s.path,guid,businessDate);
     known.set(s.endpoint,new Set([requested.guid]));
     await save(s,{reportRequested:true},requested.status,1);
    }catch(e){
     if(leaseLost())break;
     if(e instanceof ToastApiError&&e.category==="timeout"){
      reason="partial";incompleteReason="skipped_time_budget";incomplete.add(s.endpoint);break;
     }
     if(e instanceof Error&&e.message==="sample_write_failed")break;
     const status=e instanceof ToastApiError?e.status??null:null;
     const code=e instanceof ToastApiError?e.category:"unavailable";
     eraFailures.set(s.endpoint,{status,code});
     await save(s,{},status,1,code,code);
    }
    continue;
   }
   const ids=s.scope==="id"?[...(known.get(s.source??"")??[])]:[undefined];
   if(!ids.length){
    const prior=eraFailures.get(s.source??"");
    await save(s,{},prior?.status??null,null,prior?.code??"missing_resource_guid",
     prior?.code??"No eligible identifier for GET");
    continue;
   }
   const perEndpointDeadline=s.scope==="id"?
    Math.min(requestDeadlineAt,Date.now()+Math.max(3000,
     Math.floor((requestDeadlineAt-Date.now())/Math.max(1,endpointOrder.length-endpointIndex))*2)):
    requestDeadlineAt;
   const variants=s.endpoint==="orders/v2/payments"?
    ["paidBusinessDate","refundBusinessDate","voidBusinessDate"]:["paidBusinessDate"];
   const seenPayments=new Set<string>();
   for(const id of ids)for(const paymentDateField of variants){
    let nextToken:string|undefined;
    const seenTokens=new Set<string>();
    for(let page=1;page<=(s.page?PAGE_CAP:1);page++){
     if(timeLow()){
      reason="partial";incompleteReason="skipped_time_budget";incomplete.add(s.endpoint);break endpointLoop;
     }
     if(Date.now()>=perEndpointDeadline){
      incomplete.add(s.endpoint);reason="partial";
      await save(s,{},null,null,"skipped_endpoint_budget","skipped_endpoint_budget");
      continue endpointLoop;
     }
     try{
      await hold();
      let http=200,token:string|null=null;
      const requestPath=pathFor(s,businessDate,guid,id,page,nextToken,businessWindow,paymentDateField);
      const isEra=s.endpoint.startsWith("era/v1/");
      const response=isEra?await pollEra(requestPath):null;
      if(response)http=response.status;
      if(isEra&&http===202){await save(s,{},202,1,"not_ready","not_ready");continue endpointLoop;}
      let raw=isEra?response?.data:await client.request(requestPath,guid,z.unknown(),{
       deadlineAt:Math.min(requestDeadlineAt,perEndpointDeadline),
       onResponse:info=>{http=info.status;token=info.nextPageToken;}
      });
      // Payments GET returns GUIDs and can return the same payment in multiple
      // paid/refunded/voided date filters. Retain each identifier only once.
      if(s.endpoint==="orders/v2/payments"&&Array.isArray(raw)){
       raw=raw.filter(v=>{
        if(typeof v!=="string")return true;
        if(seenPayments.has(v))return false;
        seenPayments.add(v);return true;
       });
      }
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
       for(const item of list)if(item&&typeof item==="object"){
        const g=(item as Record<string,unknown>).managementGroupGuid;
        if(typeof g==="string"&&GUID.safeParse(g).success)groups.add(g);
       }
       known.set("__management_group__",groups);
      }
      await save(s,raw,http,s.page?page:variants.indexOf(paymentDateField)+1);
      if(!s.page)break;
      if(s.endpoint==="orders/v2/ordersBulk"){
       if(!list||list.length<PAGE_SIZE)break;
      }else{
       const next=token??(typeof obj?.nextPageToken==="string"?obj.nextPageToken:null);
       if(!next||seenTokens.has(next))break;
       seenTokens.add(next);nextToken=next;
      }
      if(page===PAGE_CAP){
       await save(s,{},null,page,"page_cap","Maximum 20 pages reached");
       reason="partial";
      }
     }catch(e){
      if(leaseLost()){incompleteReason="skipped_lease_lost";incomplete.add(s.endpoint);break endpointLoop;}
      if(e instanceof Error&&e.message==="sample_write_failed"){
       incompleteReason="skipped_interrupted";break endpointLoop;
      }
      if(e instanceof ToastApiError&&e.category==="timeout"){
       reason="partial";incompleteReason="skipped_time_budget";incomplete.add(s.endpoint);break endpointLoop;
      }
      // The standard client can reject a request locally when its pacing
      // deadline would expire. That is a diagnostic budget skip, not a Toast 429.
      if(e instanceof ToastApiError&&e.category==="rate_limited"&&e.retryAt&&
       Date.parse(e.retryAt)>=perEndpointDeadline){
       reason="partial";incomplete.add(s.endpoint);
       await save(s,{},null,null,"skipped_endpoint_budget","skipped_endpoint_budget");
       continue endpointLoop;
      }
      const status=e instanceof ToastApiError?e.status??null:null;
      const code=status===204?"no_content":e instanceof ToastApiError?e.toastCode??e.category:"unavailable";
      const message=e instanceof ToastApiError?e.toastMessage??e.category:"unavailable";
      await save(s,{},status,s.page?page:1,code,message);
      break;
     }
    }
   }
  }
 }catch{
  if(reason!=="lease_lost")reason="partial";
  failed++;
 }finally{
  if(finalize&&(reason==="partial"||reason==="lease_lost")){
   if(reason==="lease_lost")incompleteReason="skipped_lease_lost";
   try{await finalize();}catch{failed++;}
  }
  if(leaseNonce)try{
   const released=await db.rpc("toast_release_raw_sample_lease",{p_nonce:leaseNonce});
   if(released.error)failed++;
  }catch{failed++;}
 }
 return {captured,failed,skipped:captured===0,
  endpoints:[...summaries].map(([endpoint,v])=>({endpoint,status:v.status,count:v.count})),
  ...(reason?{reason}:{})};
}
