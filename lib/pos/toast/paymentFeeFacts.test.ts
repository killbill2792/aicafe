import {it,expect,vi,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const m=vi.hoisted(()=>({upsert:vi.fn(),disable:vi.fn(),plans:vi.fn(),choose:vi.fn()}));
vi.mock("../processingFees",()=>({upsertProcessingFeeDailyFact:m.upsert,
 setProcessingFeeCandidateEligibility:m.disable}));
vi.mock("../processingFeeEstimate.server",()=>({
 getOwnerConfirmedProcessingFeePlans:m.plans,ownerConfirmedPlanForDate:m.choose}));
import {refreshToastPaymentFeeForDay} from "./paymentFeeFacts.server";
const b="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
beforeEach(()=>{for(const fn of Object.values(m))fn.mockReset();
 m.plans.mockResolvedValue([]);m.choose.mockReturnValue(null);
 m.upsert.mockResolvedValue({});m.disable.mockResolvedValue(null);});
const fullyImported={mappings:[{restaurant_guid:"r1"}],
 days:[{restaurant_guid:"r1",import_state:"imported",coverage_complete:true,unparsed_count:0}]};
function db(payments:Array<Record<string,unknown>>,coverage:{mappings:unknown[];days:unknown[]}=fullyImported){
 const writes:Record<string,unknown>[]=[];
 return {db:{from(table:string){
  let patch:Record<string,unknown>|null=null;
  const read=table==="toast_location_mappings"?coverage.mappings:table==="toast_day_status"?coverage.days:null;
  const q={select(){return q;},eq(){return q;},not(){return q;},order(){return q;},
   update(value:Record<string,unknown>){patch=value;return q;},
   range:async(start:number,end:number)=>({data:payments.slice(start,end+1),error:null}),
   maybeSingle:async()=>({data:{rules:[]},error:null}),
   then(ok:(v:unknown)=>unknown){if(patch)writes.push(patch);
    return Promise.resolve({data:read,error:null}).then(ok);}
  };return q;
 }} as never,writes};
}
it("writes a fully supplied 33-cent Toast fee as an actual daily fact",async()=>{
 const f=db([{payment_ref:"p",payment_type:"CREDIT",card_type:"VISA",
  card_entry_mode:"SWIPED",amount_cents:1000,original_processing_fee_cents:33}]);
 await refreshToastPaymentFeeForDay(f.db,b,"2026-10-20");
 expect(m.upsert).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({
  amountCents:33,status:"actual",sourceType:"connected_pos_actual",provider:"Toast"
 }));
});
const visa={payment_ref:"p",payment_type:"CREDIT",card_type:"VISA",
 card_entry_mode:"SWIPED",amount_cents:1000,original_processing_fee_cents:33};
it("estimates a card payment Toast sent without a fee, never as actual zero",async()=>{
 const f=db([{payment_ref:"p",payment_type:"CREDIT",card_type:"VISA",
  card_entry_mode:"SWIPED",amount_cents:1000,original_processing_fee_cents:null}]);
 const result=await refreshToastPaymentFeeForDay(f.db,b,"2026-10-20");
 // 2.9% of 10.00, labelled an estimate.
 expect(result).toMatchObject({status:"estimated",amountCents:29});
});
it("uses Toast's fee for each payment and estimates only the ones without",async()=>{
 const f=db([{...visa,payment_ref:"a"},{...visa,payment_ref:"b",original_processing_fee_cents:null},
  {payment_ref:"c",payment_type:"CASH",card_type:null,card_entry_mode:null,amount_cents:500,original_processing_fee_cents:null},
  {payment_ref:"d",payment_type:"OTHER",card_type:null,card_entry_mode:null,amount_cents:500,original_processing_fee_cents:null}]);
 const result=await refreshToastPaymentFeeForDay(f.db,b,"2026-10-20");
 expect(result).toMatchObject({status:"estimated",amountCents:33+29,count:4});
});
it("never charges a fee on a declined or voided attempt",async()=>{
 const f=db([{...visa,payment_ref:"ok",original_processing_fee_cents:300,payment_status:"CAPTURED"},
  {...visa,payment_ref:"no",amount_cents:10000,original_processing_fee_cents:null,payment_status:"DENIED"}]);
 const result=await refreshToastPaymentFeeForDay(f.db,b,"2026-10-20");
 expect(result).toMatchObject({status:"actual",amountCents:300,count:1});
});
it("keeps a payment with an unknown tender type missing",async()=>{
 const f=db([{...visa,payment_ref:"a"},{payment_ref:"x",payment_type:"UNDETERMINED",card_type:null,
  card_entry_mode:null,amount_cents:500,original_processing_fee_cents:null}]);
 const result=await refreshToastPaymentFeeForDay(f.db,b,"2026-10-20");
 expect(result.status).toBe("missing");
 expect(m.upsert).not.toHaveBeenCalled();
});
it("does not publish a subtotal as the daily fee when a location has not imported the day",async()=>{
 const f=db([visa],{mappings:[{restaurant_guid:"r1"},{restaurant_guid:"r2"}],days:fullyImported.days});
 const result=await refreshToastPaymentFeeForDay(f.db,b,"2026-10-20");
 expect(result).toMatchObject({status:"missing",reason:"coverage_incomplete"});
 expect(m.upsert).not.toHaveBeenCalled();
 expect(m.disable).toHaveBeenCalled();
});
it("does not certify the daily fee while orders remain unparsed",async()=>{
 const f=db([visa],{mappings:fullyImported.mappings,
  days:[{restaurant_guid:"r1",import_state:"imported",coverage_complete:true,unparsed_count:2}]});
 const result=await refreshToastPaymentFeeForDay(f.db,b,"2026-10-20");
 expect(result).toMatchObject({status:"missing",reason:"coverage_incomplete"});
 expect(m.upsert).not.toHaveBeenCalled();
});
it("does not rewrite payments whose saved fee is already correct",async()=>{
 const f=db([{...visa,payment_ref:"same",processing_fee_cents:33,fee_status:"actual",fee_basis:"toast"},
  {...visa,payment_ref:"new"}]);
 const result=await refreshToastPaymentFeeForDay(f.db,b,"2026-10-20");
 expect(result).toMatchObject({status:"actual",amountCents:66,count:2});
 expect(f.writes).toEqual([{processing_fee_cents:33,fee_status:"actual",fee_basis:"toast"}]);
});
