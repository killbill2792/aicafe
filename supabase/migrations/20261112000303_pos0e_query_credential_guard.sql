-- POS0e security patch. Existing retained operational reader, NO new data source.
-- A camelCase-only credential denylist silently admitted snake_case reusable
-- secrets from old stored JSON via ai_toast_fields and ai_query_view. Normalize
-- only key names, preserving ordinary customer, staff and loyalty fields.
-- This migration is after the original POS0e 00156 reader and #444's 00302.
-- Does not re-process or reveal existing credential values.
set lock_timeout = '5s';
set statement_timeout = '30s';

create or replace function public.ai_query_path(p_col text) returns text[]
language sql immutable set search_path=public as $path$
 select case when p_col ~ '^data(\.([A-Za-z_][A-Za-z0-9_]{0,100}|[0-9]{1,3})){1,16}$'
  and not exists (
   select 1 from unnest(string_to_array(substr(p_col,6),'.')) s(part)
   where regexp_replace(part,'_','','g') ~* '^(pan|primaryAccountNumber|cardNumber|paymentCardNumber|cvv|cvc|cvv2|cvc2|cardVerificationValue|securityCode|magstripe|track|track1|track2|trackData|track1Data|track2Data|cardLast4|last4Digits|lastFour|first5|first6|expiration|expiry|expireDate|expirationDate|cardExpiry|cardExpiration|password|passcode|pin|apiKey|secret|clientSecret|privateKey|accessToken|refreshToken|sessionToken|authToken|authorization|authorizationToken|paymentToken|cardToken|oauthToken|bearerToken|apiSecret|token|tokenId|fingerprint|networkTransactionIdentifier|routingNumber|bankAccountNumber|accountNumber|signature)$'
      or regexp_replace(part,'_','','g') ~* '(Password|Secret|ApiKey|PrivateKey|AccessToken|RefreshToken|SessionToken|AuthToken|AuthorizationToken|OAuthToken|BearerToken|PaymentToken|CardToken|CardNumber|TrackData|SecurityCode|VerificationValue|Magstripe)$'
      or regexp_replace(part,'_','','g') ~* '^(card|cardInfo|cardDetails|cardData|creditCard|paymentCard|giftCard|giftCardInfo|paymentMethod)$'
  )
  and not (
   p_col ~* '^data\.(card|cardInfo|cardDetails|cardData|creditCard|paymentCard|giftCard|giftCardInfo|paymentMethod)\.(number|value|last4|first5|first6|lastFour|maskedNumber|expirationDate|expiryDate|expiryMonth|expiryYear|expMonth|expYear|holderName|cardholderName|networkId|networkTransactionIdentifier|accountId|accountNumber|tokenId)(\.|$)'
  )
 then string_to_array(substr(p_col,6),'.') end $path$;
revoke all on function public.ai_query_path(text) from public,anon;
grant execute on function public.ai_query_path(text) to authenticated,service_role;
