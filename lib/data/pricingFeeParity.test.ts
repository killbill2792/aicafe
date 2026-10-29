import {describe,it,expect} from "vitest";
import {monthlyProcessingFeesForWindow} from "@/lib/calc/pricingBusiness";
import {cardFeesForDays,DEFAULT_PROCESSING_FEE_RATE_BPS} from "@/lib/metrics/core/fees";

/** Parity is measured on real-shaped 90-day café sales and order facts before redirecting the reader. */
describe("pricing fees: old vs canonical",()=>{
 const days=Array.from({length:90},(_,index)=>({
   date:`2026-${index<31?"07":index<62?"08":"09"}-${String(index<31?index+1:index<62?index-30:index-61).padStart(2,"0")}`,
   netSalesCents:10000,ordersCount:20,cardFeesCents:100,cardFeesStatus:"actual" as const
 }));
 it("full actual-fee days preserve the monthly 30-day projection",()=>{
   const old=monthlyProcessingFeesForWindow(days.map(day=>day.cardFeesCents),90);
   const canonical=Math.round(cardFeesForDays(days).amountCents*30/90);
   expect(canonical).toBe(old);
   expect(canonical).toBe(3000);
 });
 it("missing fee days use a labeled estimate rather than zero",()=>{
   const gap=days.map((day,index)=>index===3?{...day,cardFeesCents:null,cardFeesStatus:"missing" as const}:day);
   const result=cardFeesForDays(gap);
   const old=monthlyProcessingFeesForWindow(days.map((d,index)=>index===3?0:d.cardFeesCents),90);
   expect(result.amountCents).toBe(89*100+Math.round(10000*DEFAULT_PROCESSING_FEE_RATE_BPS/10000));
   expect(Math.round(result.amountCents*30/90)).toBeGreaterThan(old);
   expect(result.notes).toContain("feeDefaultEstimateAskRate");
   expect(result.basis).toBe("estimated");
 });
 it("an owner fee plan wins over default, while actual days win over plans",()=>{
   const pair=[days[0],{...days[1],cardFeesCents:null,cardFeesStatus:"missing" as const}];
   const result=cardFeesForDays(pair,{percentageBps:249,fixedFeeCents:15});
   expect(result.amountCents).toBe(100+249+20*15);
   expect(result.actualDays).toBe(1);
 });
});
