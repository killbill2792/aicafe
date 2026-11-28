/** Preserve JSON field names and nesting. Normalize names only when checking
 * for payment and authentication credentials. */
const SECRET_KEY=/^(?:pan|fullPan|primaryAccountNumber|cardNumber|paymentCardNumber|cardLast4|cardLastFour|first[56]CardDigits|last4CardDigits|cvv|cvc|cvv2|cvc2|cardPin|pinBlock|cardVerificationValue|securityCode|magstripe|trackData|track1|track2|track1Data|track2Data|cardExpiry|cardExpiration|cardExpMonth|cardExpYear|cardExpirationMonth|cardExpirationYear|password|passcode|pin|apiKey|secret|clientSecret|privateKey|accessToken|refreshToken|sessionToken|authToken|authorization|authorizationToken|paymentToken|cardToken|token|routingNumber|bankAccountNumber|webhookSignature|requestSignature)$/i;
const ENDS_WITH_SECRET=/(?:Password|Secret|ApiKey|PrivateKey|AccessToken|RefreshToken|SessionToken|AuthToken|OAuthToken|BearerToken|AuthorizationToken|PaymentToken|CardToken|CardNumber|TrackData|SecurityCode|VerificationValue|Magstripe)$/i;
const CARD_SEQUENCE=/\d(?:[ -]?\d){12,}/g;
const CONTIGUOUS_CARD_SEQUENCE=/(?<!\d)\d{13,19}(?!\d)/g;
const SECRET_TEXT=/(?:\bBearer\s+\S+|\b(?:password|api[_ -]?key|client[_ -]?secret|access[_ -]?token)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{12,}|%B\d{13,19}\^[^?]*\?|;\d{13,19}=\d+\?)/gi;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_DETAIL=/^(?:last4|last4Digits|lastFour|first5|first6|firstFive|firstSix|first5Digits|first6Digits|maskedNumber|expiration|expiry|expireDate|expirationDate|expiryDate|expirationMonth|expirationYear|expiryMonth|expiryYear|expMonth|expYear|track|track1|track2|tokenId)$/i;
const CARD_DETAIL=/^(?:number|value|month|year|accountNumber|fingerprint)$/i;
const BANK_DETAIL=/^(?:number|accountNumber|tokenId)$/i;


function plausibleCardNumber(raw:string):boolean {
  if (!/^\d+(?:[ -]\d+)*$/.test(raw)) return false;
  const digits=raw.replace(/\D/g,"");
  if(digits.length<13||digits.length>19)return false;
  let total=0;let double=false;
  for(let i=digits.length-1;i>=0;i--){
   let n=Number(digits[i]);if(double){n*=2;if(n>9)n-=9;}
   total+=n;double=!double;
  }
  return total%10===0;
}
const cardContainer = /^(?:card|cardInfo|cardDetails|cardData|creditCard|debitCard|paymentCard|giftCard|giftCardInfo|paymentMethod)$/i;
const paymentContainer = /^(?:payments?|cardPayments?|tenders?)$/i;
const bankContainer = /^(?:bankAccounts?|bankAccountDetails|bankDetails|achDetails)$/i;
const normalizeKey = (name: string) => name.replace(/[^a-z0-9]/gi, "");
const isRawJson = (JSON as typeof JSON & {isRawJSON?: (value: unknown) => boolean}).isRawJSON;

function retain(value: unknown, context: "business"|"payment"|"card"|"bank"): unknown {
  if (isRawJson?.(value)) {
    return plausibleCardNumber((value as {rawJSON: string}).rawJSON) ? "[redacted]" : value;
  }
  if (Array.isArray(value)) return value.map(item => retain(item, context));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).flatMap(([name, child]) => {
      const key = normalizeKey(name);
      if (SECRET_KEY.test(key) || ENDS_WITH_SECRET.test(key) ||
          ((context === "card" || context === "payment") && PAYMENT_DETAIL.test(key)) ||
          (context === "card" && CARD_DETAIL.test(key)) ||
          (context === "bank" && BANK_DETAIL.test(key))) {
        return [];
      }
      const childContext = cardContainer.test(key) ? "card" : bankContainer.test(key) ? "bank" :
        paymentContainer.test(key) ? "payment" : context;
      return [[name, retain(child, childContext)]];
    });
    return Object.fromEntries(entries);
  }
  if (typeof value === "string" && !UUID.test(value)) {
    return value.replace(SECRET_TEXT, "[redacted]")
      .replace(CONTIGUOUS_CARD_SEQUENCE, sequence => plausibleCardNumber(sequence) ? "[redacted]" : sequence)
      .replace(CARD_SEQUENCE, sequence => plausibleCardNumber(sequence) ? "[redacted]" : sequence);
  }
  if (typeof value === "number" && plausibleCardNumber(String(value))) return "[redacted]";
  return value;
}

export function retainProviderPayload(value: unknown, kind: "business" | "payment" = "business"): unknown {
  return retain(value, kind);
}
