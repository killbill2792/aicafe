import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const h=vi.hoisted(()=>({get:vi.fn()}));
vi.mock("./client",async original=>({
 ...(await original<typeof import("./client")>()),
 createToastClient:()=>({request:h.get})
}));
import {stageToastPaymentDateReview} from "./paymentDates";
import type {SupabaseClient} from "@supabase/supabase-js";
const request={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 restaurantGuid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",businessDate:"2026-10-01"};
describe("Toast refund-date evidence",()=>{
 it("stages refund and void GUID evidence separately, never invents money",async()=>{
  const id="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  h.get.mockReset().mockResolvedValueOnce([id,id]).mockResolvedValueOnce([]);
  const rpc=vi.fn().mockResolvedValue({error:null});
  const result=await stageToastPaymentDateReview({rpc} as unknown as SupabaseClient,request);
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls[0][1].p_guids).toEqual([id]);
  expect(result).toMatchObject({requiresReview:true,verifiedZero:false,independentReportVerified:false});
 });
 it("does not interpret an empty provider GUID response as independently verified zero or settlement",async()=>{
  h.get.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  const rpc=vi.fn().mockResolvedValue({error:null});
  const result=await stageToastPaymentDateReview({rpc} as unknown as SupabaseClient,request);
  expect(result).toMatchObject({
    requiresReview:false,verifiedZero:false,refundAmountsVerified:false,
    settlementAmountsVerified:false,financialReportingVerified:false,
    independentReportVerified:false
  });
 });
 it("never stages voids if refund request failed",async()=>{
  h.get.mockReset().mockRejectedValueOnce(new Error("rate limited"));
  const rpc=vi.fn();
  await expect(stageToastPaymentDateReview({rpc} as unknown as SupabaseClient,request)).rejects.toThrow();
  expect(rpc).not.toHaveBeenCalled();
 });
});
