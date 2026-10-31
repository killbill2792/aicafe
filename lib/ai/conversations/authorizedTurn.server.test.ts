import { describe, expect, it } from "vitest";
import { externalOwnerClientMessageId } from "./authorizedTurn.server";
describe("stable external message ID",()=>{
 const cafeA={businessId:"11111111-1111-4111-8111-111111111111",ownerUserId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
 const cafeB={...cafeA,businessId:"22222222-2222-4222-8222-222222222222"};
 it("is stable for Meta redelivery, distinct across café and wamid",()=>{
   const a=externalOwnerClientMessageId(cafeA,"wamid.HBgM1234");
   expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
   expect(externalOwnerClientMessageId(cafeA,"wamid.HBgM1234")).toBe(a);
   expect(externalOwnerClientMessageId(cafeA,"wamid.HBgM1235")).not.toBe(a);
   expect(externalOwnerClientMessageId(cafeB,"wamid.HBgM1234")).not.toBe(a);
 });
 it("rejects non-provider message IDs",()=>{
   expect(()=>externalOwnerClientMessageId(cafeA,"purchase_approved")).toThrow("invalid_whatsapp_message_id");
 });
});
