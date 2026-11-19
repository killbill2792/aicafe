import {describe,it,expect} from "vitest";
import {compareCustomerPeriods,compareCustomerCohorts,compareCustomerDistributions,compareCustomerCadence,compareAnonymousCustomerPeriods,customerTrendEvidenceFields,customerCoverageReady,identityCoverage,type CustomerPeriod} from "./customers";
const base:CustomerPeriod={checks:100,linkedChecks:90,namedChecks:80,visits:80,references:60,
 firstVisits:60,returningVisits:20,knownMoneyVisits:80,averageSpendCents:900,complete:true};
describe("customer monitoring evidence gates",()=>{
 it("separates observed reference coverage, not people",()=>{
  expect(identityCoverage(base)).toBe(.9);expect(customerCoverageReady(base)).toBe(true);
  expect(identityCoverage({...base,checks:0})).toBeNull();
 });
 it("detects material returning-visit change and spending, but not missing identity or money",()=>{
  const current={...base,firstVisits:40,returningVisits:40,averageSpendCents:600};
  expect(compareCustomerPeriods(current,base)).toEqual(expect.arrayContaining([
   expect.objectContaining({key:"returning_visit_share",active:true,current:.5,previous:.25}),
   expect.objectContaining({key:"average_visit_spend",active:true,current:600})]));
  expect(compareCustomerPeriods({...current,linkedChecks:5},base)).toEqual([]);
  expect(compareCustomerPeriods({...current,complete:false},base)).toEqual([]);
  expect(compareCustomerPeriods({...current,knownMoneyVisits:79},base).find(m=>m.key==="average_visit_spend")).toBeUndefined();
 });
 it("does not mistake growth of source linkage for growth of accounts or verified recovery",()=>{
  expect(compareCustomerPeriods({...base,checks:120,linkedChecks:97},base)).not.toEqual([]);
  expect(compareCustomerPeriods({...base,checks:100,linkedChecks:80,visits:80}, {...base,linkedChecks:100})).toEqual([]);
  expect(compareCustomerPeriods(base,base).every(x=>!x.active)).toBe(true);
 });
 it("compares linked revenue concentration only with complete recorded money",()=>{
  const current={...base,linkedRevenueConcentration:.4},previous={...base,linkedRevenueConcentration:.2};
  expect(compareCustomerPeriods(current,previous)).toContainEqual(expect.objectContaining({key:"linked_revenue_concentration",active:true}));
  expect(compareCustomerPeriods({...current,knownMoneyVisits:79},previous).find(m=>m.key==="linked_revenue_concentration")).toBeUndefined();
  expect(compareCustomerPeriods({...current,linkedRevenueConcentration:null},previous).find(m=>m.key==="linked_revenue_concentration")).toBeUndefined();
 });
 it("does not compare incomplete participation or refunds as observed zero",()=>{
  const current={...base,observedDiscountShare:.4,observedLoyaltyShare:.5,recordedRefundCentsPerCheck:100,observedMeanOrderDurationSeconds:600},
   previous={...base,observedDiscountShare:.2,observedLoyaltyShare:null,recordedRefundCentsPerCheck:50,observedMeanOrderDurationSeconds:300};
  const result=compareCustomerPeriods(current,previous);
  expect(result).toContainEqual(expect.objectContaining({key:"observed_discount_participation",active:true}));
  expect(result).toContainEqual(expect.objectContaining({key:"recorded_refund_per_linked_check",active:true}));
  expect(result).toContainEqual(expect.objectContaining({key:"observed_order_duration",active:true}));
  expect(result.some(x=>x.key==="observed_loyalty_participation")).toBe(false);
 });
 it("only compares mature cohorts with comparable evidence",()=>{
  expect(compareCustomerCohorts({matured:40,observedReturns:12,complete:true},
   {matured:40,observedReturns:24,complete:true},base,base)).toMatchObject({active:true,current:.3,previous:.6});
  const valid={matured:40,observedReturns:20,complete:true};
  for(const horizon of [30,60,90] as const){
   expect(compareCustomerCohorts(valid,valid,base,base,horizon)).toMatchObject({key:`observed_return_${horizon}d`,active:false});
  }
  expect(compareCustomerCohorts({...valid,matured:0,observedReturns:0},valid,base,base)).toBeNull();
  expect(compareCustomerCohorts({...valid,complete:false},valid,base,base)).toBeNull();
 });
});

it("compares complete returning-product distributions without inventing missing bucket zeros",()=>{
 const current={dimension:"product" as const,buckets:{a:20,b:80},total:100,complete:true},
  previous={dimension:"product" as const,buckets:{a:40,b:60},total:100,complete:true};
 expect(compareCustomerDistributions(current,previous,base,base)).toContainEqual(expect.objectContaining({key:"returning_product_mix:a",current:.2,previous:.4,active:true}));
 expect(compareCustomerDistributions({...current,complete:false},previous,base,base)).toEqual([]);
 expect(compareCustomerDistributions({...current,total:101},previous,base,base)).toEqual([]);
 expect(compareCustomerDistributions(current,previous,{...base,linkedChecks:3},base)).toEqual([]);
});

it("compares cadence-qualified lapse and reappearance without treating missing evidence as recovery",()=>{
 const current={eligible:40,flagged:20,complete:true},previous={eligible:40,flagged:8,complete:true};
 expect(compareCustomerCadence("lapse",current,previous,base,base)).toMatchObject({key:"observed_long_gap_share",current:.5,previous:.2,active:true});
 expect(compareCustomerCadence("reappearance",previous,previous,base,base)).toMatchObject({key:"observed_reappearance_share",active:false});
 expect(compareCustomerCadence("lapse",{...current,eligible:3},previous,base,base)).toBeNull();
 expect(compareCustomerCadence("lapse",{...current,complete:false},previous,base,base)).toBeNull();
 expect(compareCustomerCadence("reappearance",current,previous,{...base,linkedChecks:2},base)).toBeNull();
});

it("compares signed historical recipe contribution only with complete visit cost coverage",()=>{
 const current={...base,knownContributionVisits:80,averageRecipeContributionCents:-100},
  previous={...base,knownContributionVisits:80,averageRecipeContributionCents:300};
 expect(compareCustomerPeriods(current,previous)).toContainEqual(expect.objectContaining({key:"average_recipe_contribution",active:true,current:-100,previous:300}));
 expect(compareCustomerPeriods({...current,knownContributionVisits:79},previous).some(x=>x.key==="average_recipe_contribution")).toBe(false);
 expect(compareCustomerPeriods({...current,averageRecipeContributionCents:null},previous).some(x=>x.key==="average_recipe_contribution")).toBe(false);
});

it("anonymous check and basket measures remain available without person attribution",()=>{
 const a={checks:100,knownMoneyChecks:100,netCents:60000,itemUnits:250,complete:true},b={...a,netCents:100000,itemUnits:150};
 expect(compareAnonymousCustomerPeriods(a,b)).toEqual(expect.arrayContaining([
  expect.objectContaining({key:"anonymous_check_spend",current:600,previous:1000,active:true}),
  expect.objectContaining({key:"anonymous_items_per_check",current:2.5,previous:1.5,active:true})]));
 expect(compareAnonymousCustomerPeriods({...a,knownMoneyChecks:99,itemUnits:null},b)).toEqual([]);
 expect(compareAnonymousCustomerPeriods({...a,complete:false},b)).toEqual([]);
});
it("historical value is compared only with all active references costed in recorded money",()=>{
 const a={...base,knownHistoryAccounts:60,averageHistoryAccountCents:2000},b={...base,knownHistoryAccounts:60,averageHistoryAccountCents:1000};
 expect(compareCustomerPeriods(a,b)).toContainEqual(expect.objectContaining({key:"observed_history_value",current:2000,previous:1000,active:true}));
 expect(compareCustomerPeriods({...a,knownHistoryAccounts:59},b).some(x=>x.key==="observed_history_value")).toBe(false);
});

it("every emitted customer monitor has an explicit numeric corroboration dependency",()=>{
 const a={...base,knownHistoryAccounts:60,averageHistoryAccountCents:2000,linkedRevenueConcentration:.4,
  observedDiscountShare:.4,observedLoyaltyShare:.5,recordedRefundCentsPerCheck:100,
  observedMeanOrderDurationSeconds:600,knownContributionVisits:80,averageRecipeContributionCents:300};
 const sample={eligible:40,flagged:8,complete:true};
 const measures=[...compareCustomerPeriods(a,a),
  ...compareAnonymousCustomerPeriods({checks:100,knownMoneyChecks:100,netCents:1000,itemUnits:100,complete:true},{checks:100,knownMoneyChecks:100,netCents:1000,itemUnits:100,complete:true}),
  ...(["product","modifier","basket","weekday","channel","daypart"] as const).flatMap(dimension=>{
   const d={dimension,buckets:{a:40,b:60},total:100,complete:true};
   return compareCustomerDistributions(d,d,a,a);
  }),
  ...([7,30,60,90] as const).map(h=>compareCustomerCohorts({matured:40,observedReturns:20,complete:true},{matured:40,observedReturns:20,complete:true},a,a,h)),
  compareCustomerCadence("lapse",sample,sample,a,a),compareCustomerCadence("reappearance",sample,sample,a,a)];
 expect(measures.length).toBeGreaterThan(25);
 for(const m of measures){expect(m).not.toBeNull();expect(customerTrendEvidenceFields(m!.key).length,m!.key).toBeGreaterThan(0);}
 expect(customerTrendEvidenceFields("unrecognized_customer_trend")).toEqual([]);
});
