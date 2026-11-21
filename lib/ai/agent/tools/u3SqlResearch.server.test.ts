import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {unsafeStructuredToastResult} from "./u3SqlResearch.server";

describe("U3 retained Toast result safety",()=>{
 it("permits approved scalar observations and dates",()=>{
  expect(unsafeStructuredToastResult([
   {record_type:"check",count:7,amount_cents:"12345",observed_at:new Date("2026-11-20T00:00:00Z")},
   {name:"Vanilla Latte",business_date:"2026-11-19",missing:null}
  ])).toBe(false);
 });
 it("refuses raw objects, arrays, serialized nested JSON and unknown row shapes",()=>{
  for(const payload of [
   [{data:{customer:{firstName:"test",accessToken:"not visible"}}}],
   [{alias:[{secret:"not visible"}]}],
   [{alias:'{"customer":{"cardNumber":"never send"}}'}],
   [{alias:'[{"paymentToken":"never send"}]'}],
   [{alias:Buffer.from("blocked")}],
   [null]
  ])expect(unsafeStructuredToastResult(payload)).toBe(true);
 });
 it("does not mistake ordinary scalar strings for a structured record",()=>{
  expect(unsafeStructuredToastResult([{value:"{not parsed}"},
   {value:"Vanilla [large]"}, {value:"12345.00"}])).toBe(false);
 });
});
