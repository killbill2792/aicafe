import {expect, it} from "vitest";
import {retainProviderPayload} from "./retainPayload";

it("preserves opaque field names, array order and nested provider extensions", () => {
  const source = JSON.parse('{"__proto__":{"v":1},"工时":[null,{"net-total $":2}]}');
  let nested = source;
  for (let i = 0; i < 50; i++) nested = {"extension data": [nested]};
  expect(JSON.stringify(retainProviderPayload(nested))).toBe(JSON.stringify(nested));
});

it("filters credentials in new provider fields without dropping sibling business data", () => {
  const source = {"payment method": {"Card Details": {"Number": 4111111111111111, brand: "VISA"}},
    "client.secret": "private", extra: [4111111111111111, {note: "unrelated"}]};
  expect(retainProviderPayload(source)).toEqual({"payment method": {"Card Details": {brand: "VISA"}},
    extra: ["[redacted]", {note: "unrelated"}]});
});

it("keeps business metadata and transaction references whose names overlap with credential fields", () => {
  const source = {
    inventory: {expiry: "2026-12-01", track: true, signature: "received by owner", fingerprint: "lot-A"},
    supplier: {accountNumber: "invoice-ledger", networkId: "distributor-A"},
    payments: [{networkTransactionIdentifier: "payment-reference", expirationYear: 2030,
      amount: 100, card: {number: "4111111111111111", tokenId: "reusable", brand: "VISA"}}],
    bankAccount: {accountNumber: "123456789", institution: "Bank"},
    memo: "Use oat milk. Card 4111 1111 1111 1111 belongs to the customer.",
    sourceReference: "12345678901234567890123",
  };
  expect(retainProviderPayload(source)).toEqual({
    ...source,
    payments: [{networkTransactionIdentifier: "payment-reference", amount: 100, card: {brand: "VISA"}}],
    bankAccount: {institution: "Bank"},
    memo: "Use oat milk. Card [redacted] belongs to the customer.",
  });
});
