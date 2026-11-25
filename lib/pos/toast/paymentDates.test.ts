import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const h=vi.hoisted(()=>({get:vi.fn()}));
vi.mock("./client",async original=>({
 ...(await original<typeof import("./client")>()),
 createToastClient:()=>({request:h.get})
}));
import {stageToastPaymentDateReview,needsFinalPaymentDetail,finalizeToastPaymentWindow} from "./paymentDates";
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


it("only requests final payment details for adjustments, missing fees or unfinished captures",()=>{
 const guid="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
 const base={payment_ref:guid,payment_type:"CREDIT",payment_status:"CAPTURED",original_processing_fee_cents:23,status:"actual"};
 expect(needsFinalPaymentDetail({guid,adjustment:false},[base])).toBe(false);
 expect(needsFinalPaymentDetail({guid,adjustment:true},[base])).toBe(true);
 expect(needsFinalPaymentDetail({guid,adjustment:false},[{...base,original_processing_fee_cents:null}])).toBe(true);
 expect(needsFinalPaymentDetail({guid,adjustment:false},[{...base,payment_status:"AUTHORIZED"}])).toBe(true);
 expect(needsFinalPaymentDetail({guid,adjustment:false},[{...base,payment_type:"CASH",original_processing_fee_cents:null}])).toBe(false);
 expect(needsFinalPaymentDetail({guid,adjustment:false},[])).toBe(true);
});


it("reads the final payment-date lists once, skips already known captures and stops after the receipt",async()=>{
 const guid="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
 let sources:Record<string,unknown>={};
 const rpc=vi.fn().mockResolvedValue({error:null});
 const db={rpc,from:(table:string)=>{
  const q={select:()=>q,eq:()=>q,in:async()=>({data:[{payment_ref:guid,payment_type:"CREDIT",
   payment_status:"CAPTURED",original_processing_fee_cents:23,status:"actual"}],error:null}),
   maybeSingle:async()=>({data:table==="toast_optional_sync_state"?{operational_sources:sources}:{import_state:"imported"},error:null}),
   upsert:async(value:{operational_sources:Record<string,unknown>})=>{sources=value.operational_sources;return {error:null};}};
  return q;
 }} as unknown as SupabaseClient;
 h.get.mockReset().mockResolvedValueOnce([guid]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
 const scope={businessId:request.businessId,restaurantGuid:request.restaurantGuid,timezone:"America/Los_Angeles",closeoutHour:4};
 const now=new Date("2026-10-02T12:00:00-07:00");
 await finalizeToastPaymentWindow(db,scope,request.businessDate,now,Date.now()+60000);
 expect(h.get).toHaveBeenCalledTimes(3);
 expect(sources.final_payments).toMatchObject({completed_through:request.businessDate,status:"current",count:1});
 await finalizeToastPaymentWindow(db,scope,request.businessDate,now,Date.now()+60000);
 expect(h.get).toHaveBeenCalledTimes(3);
});
