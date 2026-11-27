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
