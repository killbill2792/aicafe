// Shared Toast sanitization before the existing archive and diagnostic capture.
// Keep provider-permitted customer/staff/contact/loyalty identity and business notes;
// remove card credentials and reusable auth/security secrets in every nested object.
// Source completeness and café/role authorization are enforced by the existing writer
// and SQL readers respectively. Free text remains untrusted DATA, never instructions.
export const KEY=/^[A-Za-z_][A-Za-z0-9_]{0,100}$/;

// The separate manual diagnostic field-frequency counter uses this helper to
// classify identity fields. Operational retention intentionally does NOT hash
// or discard permitted stable customer/employee/loyalty identifiers.
export const isSensitiveId=(key:string,context:string)=>
 /^(?:customer|guest|loyalty|card|creditCard|giftCard)(?:Id|Guid|Identifier|AccountId|AccountGuid|AccountNumber|ExternalId|Fingerprint|TokenId)$/i.test(key)||
 /^(?:id|guid|referenceId|externalId|accountId|accountGuid|fingerprint|identifier|tokenId)$/i.test(key)&&
 /^(?:customer|customerInfo|customerDetails|guest|guestInfo|loyalty|loyaltyAccount|patron|card|cardInfo|cardDetails|giftCard|giftCardInfo|creditCard|paymentCard|cardholder)$/i.test(context);

// Only payment credentials and reusable security secrets are excluded. A name,
// contact address, loyalty GUID, staff GUID, order reference or note is not a
// credential merely because it belongs to a person.
const SECRET_KEY=/^(?:pan|primaryAccountNumber|cardNumber|paymentCardNumber|cardLast4|last4Digits|lastFour|last4|firstFive|firstSix|first5|first6|cvv|cvc|cvv2|cvc2|cardVerificationValue|securityCode|magstripe|track|trackData|track1|track2|track1Data|track2Data|expiration|expiry|expireDate|cardExpiry|cardExpiration|password|passcode|pin|apiKey|secret|clientSecret|privateKey|accessToken|refreshToken|sessionToken|authToken|authorization|authorizationToken|paymentToken|cardToken|token|tokenId|fingerprint|routingNumber|bankAccountNumber|accountNumber|networkId|networkTransactionIdentifier|signature)$/i;
const ENDS_WITH_SECRET=/(?:Password|Secret|ApiKey|PrivateKey|AccessToken|RefreshToken|SessionToken|AuthToken|PaymentToken|CardToken|CardNumber|TrackData|SecurityCode|VerificationValue|Magstripe)$/i;
const CARD_SEQUENCE=/(?:\d[ -]?){13,19}/g;
const SECRET_TEXT=/(?:\bBearer\s+\S+|\b(?:password|api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{12,})/i;
const PHONE_FIELD=/^(?:phone|phoneNumber|mobile|mobileNumber|contactPhone|telephone|fax)$/i;
const GUID_FIELD=/(?:^guid$|Guid$|UUID$|Uuid$|^id$|Id$)/;

function plausibleCardNumber(value:string):boolean {
 const matches=value.match(CARD_SEQUENCE)??[];
 return matches.some(raw=>{
  const digits=raw.replace(/\D/g,"");
  if(digits.length<13||digits.length>19)return false;
  // Reject 13–19 digits in free text; phone keys preserve non-card telephone
  // numbers but still reject structurally valid PANs (Luhn).
  let total=0;let double=false;
  for(let i=digits.length-1;i>=0;i--){
   let n=Number(digits[i]);if(double){n*=2;if(n>9)n-=9;}
   total+=n;double=!double;
  }
  return total%10===0;
 });
}
function safeString(value:string,key:string):string{
 if(value.length>100000||SECRET_TEXT.test(value))return "[redacted]";
 if(plausibleCardNumber(value))return "[redacted]";
 // The numeric run check is conservative for arbitrary notes, but allows
 // non-card phone numbers and provider-stable identifiers as business facts.
 if(!PHONE_FIELD.test(key)&&!GUID_FIELD.test(key)&&
  (value.match(CARD_SEQUENCE)??[]).some(s=>s.replace(/\D/g,"").length>=13))
  return "[redacted]";
 return value;
}
export function redactToastRaw(value:unknown,depth=0,key="",_hashKey?:string,
 _context="",_scope=""):unknown{
 if(depth>32)return null;
 if(Array.isArray(value))return value.map(v=>redactToastRaw(v,depth+1,key,_hashKey,_context,_scope));
 if(value&&typeof value==="object"){
  return Object.fromEntries(Object.entries(value as Record<string,unknown>)
   .filter(([k])=>KEY.test(k)&&!SECRET_KEY.test(k)&&!ENDS_WITH_SECRET.test(k))
   .map(([k,v])=>[k,redactToastRaw(v,depth+1,k,_hashKey,k,_scope)]));
 }
 if(typeof value==="string")return safeString(value,key);
 return value;
}
