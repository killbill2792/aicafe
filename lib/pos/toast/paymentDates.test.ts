import {describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
const h=vi.hoisted(()=>({get:vi.fn(),ingest:vi.fn()}));
vi.mock("./orderIngestion",()=>({fetchAndIngestToastOrder:h.ingest}));
vi.mock("./client",async original=>({
 ...(await original<typeof import("./client")>()),
 createToastClient:()=>({request:h.get,assertSourceAccess:async()=>"grant-v1"})
}));
import {stageToastPaymentDateReview,needsFinalPaymentDetail,finalizeToastPaymentWindow} from "./paymentDates";
import type {SupabaseClient} from "@supabase/supabase-js";
const request={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 restaurantGuid:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",businessDate:"2026-10-01"};
const rpcWithArchive=()=>vi.fn(async(name:string,args:Record<string,unknown>)=>({
 data:name==="external_commit_page"?Number(args.p_revision)+1:
  name==="toast_apply_archived_payment_fee"?"applied":true,error:null,
}));
const reviewDatabase=(rpc:ReturnType<typeof rpcWithArchive>)=>{
 const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:null,error:null})};
 return {rpc,from:()=>query} as unknown as SupabaseClient;
};
describe("Toast refund-date evidence",()=>{
 it("stages refund and void GUID evidence separately, never invents money",async()=>{
  const id="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  h.get.mockReset().mockResolvedValueOnce([id,id]).mockResolvedValueOnce([]);
  const rpc=rpcWithArchive();
  const result=await stageToastPaymentDateReview(reviewDatabase(rpc),request);
  const events=rpc.mock.calls.filter(([name])=>name==="toast_stage_payment_day_events");
  expect(events).toHaveLength(2);
  expect(events[0][1].p_guids).toEqual([id]);
  expect(rpc).toHaveBeenCalledWith("external_commit_page",expect.objectContaining({
   p_next:{cursor:null,scope:{businessDate:request.businessDate,dateField:"refundBusinessDate"},mode:"window"},
   p_records:[expect.objectContaining({payload:[id,id]})],
  }));
  expect(result).toMatchObject({requiresReview:true,verifiedZero:false,independentReportVerified:false});
 });
 it("does not interpret an empty provider GUID response as independently verified zero or settlement",async()=>{
  h.get.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  const rpc=rpcWithArchive();
  const result=await stageToastPaymentDateReview(reviewDatabase(rpc),request);
  expect(result).toMatchObject({
    requiresReview:false,verifiedZero:false,refundAmountsVerified:false,
    settlementAmountsVerified:false,financialReportingVerified:false,
    independentReportVerified:false
  });
 });
 it("never stages voids if refund request failed",async()=>{
  h.get.mockReset().mockRejectedValueOnce(new Error("rate limited"));
  const rpc=rpcWithArchive();
  await expect(stageToastPaymentDateReview(reviewDatabase(rpc),request)).rejects.toThrow("rate limited");
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
 const rpc=rpcWithArchive();
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

it.each(["AUTHORIZED","CAPTURED"])("retains %s credit payments missing final fee and retries only their detail",async(status)=>{
 const guid="cccccccc-cccc-4ccc-8ccc-cccccccccccc",orderGuid="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
 const another="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
 let sources:Record<string,unknown>={};
 const rpc=rpcWithArchive();
 const db={rpc,from:(table:string)=>{
  const q={select:()=>q,eq:()=>q,in:async()=>({data:[{payment_ref:another,payment_type:"CREDIT",
   payment_status:"CAPTURED",original_processing_fee_cents:20,status:"actual"}],error:null}),
   maybeSingle:async()=>({data:table==="toast_optional_sync_state"?{operational_sources:sources}:{import_state:"imported"},error:null}),
   upsert:async(value:{operational_sources:Record<string,unknown>})=>{sources=value.operational_sources;return {error:null};}};
  return q;
 }} as unknown as SupabaseClient;
 const scope={businessId:request.businessId,restaurantGuid:request.restaurantGuid,timezone:"America/Los_Angeles",closeoutHour:4};
 const now=new Date("2026-10-02T12:00:00-07:00"),later=(minutes:number)=>new Date(now.getTime()+minutes*60000);
 const payment={guid,orderGuid,type:"CREDIT",paymentStatus:status,paidBusinessDate:20261001,amount:10,originalProcessingFee:null};
 h.get.mockReset().mockResolvedValueOnce([guid,another]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(payment);
 h.ingest.mockReset().mockResolvedValue("unchanged");
 await finalizeToastPaymentWindow(db,scope,request.businessDate,now,Date.now()+60000);
 expect(h.get).toHaveBeenCalledTimes(4);expect(h.ingest).toHaveBeenCalledTimes(1);
 expect(sources.final_payments).toMatchObject({completed_through:request.businessDate,status:"pending",
  pending_details:[{entry:{guid},day:request.businessDate,attempts:1,retry_at:later(15).toISOString()}]});
 await finalizeToastPaymentWindow(db,scope,request.businessDate,later(5),Date.now()+60000);
 expect(h.get).toHaveBeenCalledTimes(4);
 h.get.mockResolvedValueOnce(payment);
 await finalizeToastPaymentWindow(db,scope,request.businessDate,later(15),Date.now()+60000);
 expect(h.get).toHaveBeenCalledTimes(5);expect(h.ingest).toHaveBeenCalledTimes(1);
 expect(sources.final_payments).toMatchObject({status:"pending",pending_details:[{attempts:2,retry_at:later(45).toISOString()}]});
 h.get.mockResolvedValueOnce({...payment,paymentStatus:"CAPTURED",originalProcessingFee:0.23});
 await finalizeToastPaymentWindow(db,scope,request.businessDate,later(45),Date.now()+60000);
 expect(rpc).toHaveBeenCalledWith("toast_apply_archived_payment_fee",{
  p_business_id:request.businessId,p_restaurant_guid:request.restaurantGuid,p_payment_guid:guid,p_revision:1,
 });
 expect(sources.final_payments).toMatchObject({status:"current",pending_details:[],error:null});
 await finalizeToastPaymentWindow(db,scope,request.businessDate,later(60),Date.now()+60000);
 expect(h.get).toHaveBeenCalledTimes(6);
});

it("retains exhausted missing-fee evidence and stops automatic provider requests",async()=>{
 const guid="cccccccc-cccc-4ccc-8ccc-cccccccccccc",orderGuid="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
 let sources:Record<string,unknown>={};
 const rpc=rpcWithArchive();
 const db={rpc,from:(table:string)=>{
  const q={select:()=>q,eq:()=>q,in:async()=>({data:[],error:null}),
   maybeSingle:async()=>({data:table==="toast_optional_sync_state"?{operational_sources:sources}:{import_state:"imported"},error:null}),
   upsert:async(value:{operational_sources:Record<string,unknown>})=>{sources=value.operational_sources;return {error:null};}};
  return q;
 }} as unknown as SupabaseClient;
 const scope={businessId:request.businessId,restaurantGuid:request.restaurantGuid,timezone:"America/Los_Angeles",closeoutHour:4};
 const now=new Date("2026-10-02T12:00:00-07:00");
 const payment={guid,orderGuid,type:"CREDIT",paymentStatus:"CAPTURED",paidBusinessDate:20261001,amount:10,originalProcessingFee:null};
 h.get.mockReset().mockResolvedValueOnce([guid]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue(payment);
 h.ingest.mockReset().mockResolvedValue("unchanged");
 await finalizeToastPaymentWindow(db,scope,request.businessDate,now,Date.now()+60000);
 for(let i=1;i<8;i++){
  const state=sources.final_payments as {pending_details:{retry_at:string}[]};
  await finalizeToastPaymentWindow(db,scope,request.businessDate,new Date(state.pending_details[0].retry_at),Date.now()+60000);
 }
 expect(sources.final_payments).toMatchObject({completed_through:request.businessDate,status:"unresolved",
  error:"payment_detail_unresolved",pending_details:[{entry:{guid},attempts:8,retry_at:null}]});
 expect(h.get).toHaveBeenCalledTimes(11);
 expect(h.ingest).toHaveBeenCalledTimes(1);
 await finalizeToastPaymentWindow(db,scope,request.businessDate,new Date(now.getTime()+7*86400000),Date.now()+60000);
 expect(h.get).toHaveBeenCalledTimes(11);
 expect(rpc).not.toHaveBeenCalledWith("toast_apply_archived_payment_fee",expect.anything());
});

it("retries a deferred fee with its receipt and only refetches replaced evidence after backoff",async()=>{
 const guid="cccccccc-cccc-4ccc-8ccc-cccccccccccc",orderGuid="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
 let sources:Record<string,unknown>={},revision=0,feeResult="order_pending";
 const rpc=rpcWithArchive();
 rpc.mockImplementation(async(name,args)=>{
  if(name==="external_commit_page"){
   if(args.p_stream===guid)revision++;
   return {data:Number(args.p_revision)+1,error:null};
  }
  if(name==="toast_apply_archived_payment_fee")return {data:feeResult,error:null};
  return {data:true,error:null};
 });
 const db={rpc,from:(table:string)=>{
  const q={select:()=>q,eq:()=>q,in:async()=>({data:[],error:null}),
   maybeSingle:async()=>({data:table==="toast_optional_sync_state"?{operational_sources:sources}:
    table==="external_sync_checkpoints"?{revision,cursor_state:null}:{import_state:"imported"},error:null}),
   upsert:async(value:{operational_sources:Record<string,unknown>})=>{sources=value.operational_sources;return {error:null};}};
  return q;
 }} as unknown as SupabaseClient;
 const scope={businessId:request.businessId,restaurantGuid:request.restaurantGuid,timezone:"America/Los_Angeles",closeoutHour:4};
 const now=new Date("2026-10-02T12:00:00-07:00"),later=(minutes:number)=>new Date(now.getTime()+minutes*60000);
 const payment={guid,orderGuid,type:"CREDIT",paymentStatus:"CAPTURED",paidBusinessDate:20261001,amount:10,originalProcessingFee:0.23};
 h.get.mockReset().mockResolvedValueOnce([guid]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(payment);
 h.ingest.mockReset().mockResolvedValue("queued");
 await finalizeToastPaymentWindow(db,scope,request.businessDate,now,Date.now()+60000);
 expect(sources.final_payments).toMatchObject({status:"pending",error:"payment_order_pending"});
 expect((sources.final_payments as {deferred:unknown[]}).deferred).toEqual([
  {guid,adjustment:false,feeReceipt:{externalRevision:1,day:request.businessDate}},
 ]);
 feeResult="refresh_evidence";
 await finalizeToastPaymentWindow(db,scope,request.businessDate,later(15),Date.now()+60000);
 expect(h.get).toHaveBeenCalledTimes(4);
 expect(sources.final_payments).toMatchObject({deferred:[],status:"pending",error:"payment_detail_pending",
  pending_details:[{entry:{guid},attempts:1,retry_at:later(30).toISOString()}]});
 feeResult="applied";
 h.get.mockResolvedValueOnce({...payment,originalProcessingFee:0});
 await finalizeToastPaymentWindow(db,scope,request.businessDate,later(30),Date.now()+60000);
 expect(rpc).toHaveBeenLastCalledWith("toast_apply_archived_payment_fee",expect.objectContaining({p_payment_guid:guid,p_revision:2}));
 expect(h.get).toHaveBeenCalledTimes(5);
 expect(h.ingest).toHaveBeenCalledTimes(1);
 expect(sources.final_payments).toMatchObject({pending_details:[],deferred:[],status:"current"});
});
