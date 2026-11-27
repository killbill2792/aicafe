/** Preserve JSON field names and nesting. Normalize names only when checking
 * for payment and authentication credentials. */
const SECRET_KEY=/^(?:pan|fullPan|primaryAccountNumber|cardNumber|paymentCardNumber|cardLast4|last4Digits|lastFour|last4|firstFive|firstSix|first5|first6|first5Digits|first6Digits|cvv|cvc|cvv2|cvc2|cardPin|pinBlock|cardVerificationValue|securityCode|magstripe|track|trackData|track1|track2|track1Data|track2Data|expiration|expiry|expireDate|cardExpiry|cardExpiration|expirationMonth|expirationYear|expiryMonth|expiryYear|expMonth|expYear|cardExpMonth|cardExpYear|cardExpirationMonth|cardExpirationYear|password|passcode|pin|apiKey|secret|clientSecret|privateKey|accessToken|refreshToken|sessionToken|authToken|authorization|authorizationToken|paymentToken|cardToken|token|tokenId|fingerprint|routingNumber|bankAccountNumber|accountNumber|networkId|networkTransactionIdentifier|signature)$/i;
const ENDS_WITH_SECRET=/(?:Password|Secret|ApiKey|PrivateKey|AccessToken|RefreshToken|SessionToken|AuthToken|PaymentToken|CardToken|CardNumber|TrackData|SecurityCode|VerificationValue|Magstripe)$/i;
const CARD_SEQUENCE=/(?:\d[ -]?){13,19}/g;
const SECRET_TEXT=/(?:\bBearer\s+\S+|\b(?:password|api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{12,})/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD_CHILD_SECRET=/^(?:number|value|last4|first5|first6|first5Digits|first6Digits|lastFour|maskedNumber|expirationDate|expiryDate|expiryMonth|expiryYear|expMonth|expYear|month|year|networkId|networkTransactionIdentifier|accountId|accountNumber|tokenId)$/i;


function plausibleCardNumber(value:string):boolean {
 const matches=value.match(CARD_SEQUENCE)??[];
 return matches.some(raw=>{
  const digits=raw.replace(/\D/g,"");
  if(digits.length<13||digits.length>19)return false;
  let total=0;let double=false;
  for(let i=digits.length-1;i>=0;i--){
   let n=Number(digits[i]);if(double){n*=2;if(n>9)n-=9;}
   total+=n;double=!double;
  }
  return total%10===0;
 });
}
const cardContainer = /^(?:card|cardInfo|cardDetails|cardData|creditCard|paymentCard|giftCard|giftCardInfo|magstripe|paymentMethod)$/i;
const normalizeKey = (name: string) => name.replace(/[^a-z0-9]/gi, "");

export function retainProviderPayload(value: unknown, inCard = false): unknown {
  if (Array.isArray(value)) return value.map(item => retainProviderPayload(item, inCard));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).flatMap(([name, child]) => {
      const key = normalizeKey(name);
      if (SECRET_KEY.test(key) || ENDS_WITH_SECRET.test(key) || (inCard && CARD_CHILD_SECRET.test(key))) {
        return [];
      }
      return [[name, retainProviderPayload(child, inCard || cardContainer.test(key))]];
    });
    return Object.fromEntries(entries);
  }
  if (typeof value === "string" && !UUID.test(value) &&
      (SECRET_TEXT.test(value) || plausibleCardNumber(value))) return "[redacted]";
  if (typeof value === "number" && plausibleCardNumber(String(value))) return "[redacted]";
  return value;
}
