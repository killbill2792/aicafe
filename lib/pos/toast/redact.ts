import {createHmac} from "node:crypto";
import {GUID} from "./client";

// One redaction for everything we keep from Toast: raw samples, staged day
// pages and the permanent archive. It runs in the app, before the database,
// so day imports never redact inside a time-limited database request.
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
export const KEY=/^[A-Za-z_][A-Za-z0-9_]{0,100}$/;
const isPersonalContext=(context:string)=>PERSONAL_PARENT.test(context);
export const isSensitiveId=(key:string,context:string)=>CUSTOMER_ID.test(key)||
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
    // name of the menu item; nested selections/applied discounts/service charges are retained.
    if(PERSONAL_FIELD.test(k)&&(/^(?:orders?|checks?|payments?|employee|staff|server|cashier)$/i.test(context)||isPersonalContext(context)))return false;
    return true;
   })
   .filter(([k,v])=>!isPersonalContext(context)||typeof v!=="string"||
    isSensitiveId(k,context)||/^(?:type|status|state|currency|cardType|cardEntryMode|jobTitle|jobCode|title|paymentStatus|source)$/i.test(k)||
    /(?:Date|Time|At|Timestamp)$/i.test(k))
   .map(([k,v])=>[k,redactToastRaw(v,depth+1,k,hashKey,k==="selections"||k==="discounts"||k==="appliedDiscounts"||k==="appliedServiceCharges"||k==="modifiers"||k==="items"||k==="menuItems"?"":(PERSONAL_PARENT.test(k)||/^(?:giftCard|giftCardInfo|orders?|checks?|payments?|employee|staff|server|cashier)$/i.test(k))?k:context,scope)])
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
