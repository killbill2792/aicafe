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
function db(payments:Array<Record<string,unknown>>){
 const writes:Record<string,unknown>[]=[];
 return {db:{from(table:string){
  let patch:Record<string,unknown>|null=null;
  const q={select(){return q;},eq(){return q;},order(){return q;},
   update(value:Record<string,unknown>){patch=value;return q;},
   range:async(start:number,end:number)=>({data:payments.slice(start,end+1),error:null}),
   maybeSingle:async()=>({data:{rules:[]},error:null}),
   then(ok:(v:unknown)=>unknown){if(patch)writes.push(patch);
    return Promise.resolve({data:null,error:null}).then(ok);}
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
it("does not certify an incomplete payment fee as actual zero",async()=>{
 const f=db([{payment_ref:"p",payment_type:"CREDIT",card_type:"VISA",
  card_entry_mode:"SWIPED",amount_cents:1000,original_processing_fee_cents:null}]);
 const result=await refreshToastPaymentFeeForDay(f.db,b,"2026-10-20");
 expect(result.status).toBe("missing");
 expect(m.upsert).not.toHaveBeenCalled();
 expect(m.disable).toHaveBeenCalled();
});
