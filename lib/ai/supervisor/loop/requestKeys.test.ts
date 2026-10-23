import {describe,it,expect} from "vitest";
import {proposalRequestKey} from "./requestKeys";
describe("deterministic proposal UUIDv5 keys",()=>{
  const thread="11111111-1111-4111-8111-111111111111";
  it("same owner message and arguments always recover the same draft",()=>{
    const name=JSON.stringify({ownerMessageId:"22222222-2222-4222-8222-222222222222",
      productId:"33333333-3333-4333-8333-333333333333",newPriceCents:475});
    const key=proposalRequestKey(thread,name);
    expect(proposalRequestKey(thread,name)).toBe(key);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(proposalRequestKey(thread,name.replace("475","500"))).not.toBe(key);
    expect(proposalRequestKey("44444444-4444-4444-8444-444444444444",name)).not.toBe(key);
  });
  it("rejects an invalid namespace",()=>{
    expect(()=>proposalRequestKey("not-a-uuid","same")).toThrow();
  });
});
