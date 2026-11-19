import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {localizedMetricReason} from "@/lib/ai/agent/metricReasons";
import { z } from "zod";
import {financialSettlementInputSchema} from "@/lib/ai/supervisor/loop/supplierReceiving.server";
import type { AgentToolContext, AgentToolResult } from "./index";
import { requestedPeriod } from "./period";
import {resolveOwnerPeriod,resolveEntity,choicePayload,periodChoicePayload} from "../resolve";
import {money,type ExplainLine} from "../explain";
import type {SupervisorEconomicsRead} from "@/lib/data/supervisorEconomics.server";
import {breakEvenSnapshotInputs,type BreakEvenPeriodMode,type BreakEvenInputOptions} from "@/lib/viewmodels/breakEvenViewModel";
import {shiftCafeDate} from "@/lib/metrics/core/clock";
import {safeSumCents} from "@/lib/calc/explainMath";
import {ownerInputsSchema,ownerPeriod} from "./ownerInputs";
import {prorate,calendarMonth} from "@/lib/calc/periods";
import {figure} from "@/lib/calc/supervisorEconomics";
import {dailyBreakEvenSalesCents} from "@/lib/metrics/core/breakEven";

const period=z.strictObject({period:z.union([z.string().min(1).max(32),z.strictObject({preset:z.enum(["today","week","month","last_week","last_month","ytd"])}),z.strictObject({from:z.iso.date(),to:z.iso.date()})])});
const empty=z.strictObject({});
// Nullable for the Responses strict-tool schema. Omitted fields keep existing callers working.
const breakEvenInput=z.strictObject({
  ownerIngredientPackagingPercent:z.number().min(0).max(99.99).nullable().optional(),
  ownerProcessingFeePercent:z.number().min(0).max(99.99).nullable().optional(),
  ownerNetSalesCents:z.number().int().nonnegative().nullable().optional(),
  ownerSalesDays:z.number().int().positive().nullable().optional(),
  ownerOpenDaysPerMonth:z.number().int().min(1).max(31).nullable().optional(),
  ownerInputs:ownerInputsSchema.nullable().optional(),
  period:z.enum(["month","month_to_date","today"]).nullable().optional(),
});
const unavailable=(source:string,period:{from:string;to:string}|null,missing:string[]):AgentToolResult=>
  ({source,period,agentId:"leo",missing:missing.length?missing:["sourceUnavailable"]});
type CanonicalBreakEven=NonNullable<SupervisorEconomicsRead["canonicalBreakEven"]>;
/** Standard and owner-adjusted answers use Money/Plan's one core metric. */
function canonicalBreakEvenAnswer(
 basis:CanonicalBreakEven,asOf:string,locale:"en"|"es"|"ar",
 openDaysSource:"opening_hours"|"calendar"="calendar",
):AgentToolResult{
 const mode=basis.mode??"month_forecast";
 const month=calendarMonth(asOf);
 const period=mode==="today"?{from:asOf,to:asOf}:
   mode==="month_to_date"?{from:month.from,to:basis.periodEnd}:month;
 const calc=basis.shared.calculation;
 const amount=basis.shared.salesPerMonthCents;
 const daily=mode==="today"?amount:
   dailyBreakEvenSalesCents(amount,Math.max(1,basis.targetOpenDays));
 const covered=basis.elapsedOpenDates.length-basis.missingLaborDates.length;
 const laborPartial=basis.missingLaborDates.length>0;
 const laborForecast=mode==="month_forecast"&&basis.forecastLabor;
 const taxEstimated=basis.estimatedStaffTax||
   (laborForecast&&basis.payrollTaxRateStatus==="estimated");
 const laborEstimate=laborPartial||laborForecast||
   basis.monthLabor.basis!=="recorded"||taxEstimated||basis.ownerExtrasPresent;
 const bills=figure(basis.monthlyBillsCents,
   basis.ownerBillsOverride?"owner":basis.missingBills||basis.estimatedBills?"estimate":"actual",
   basis.missingBills?"billsPartial":"billsRecorded");
 const staff=figure(basis.monthlyStaffCents,laborEstimate?"estimate":"actual",
   laborPartial?"laborPartialCoverage":
     laborForecast?"laborEstimated":taxEstimated?"laborEstimated":
     basis.ownerExtrasPresent?"laborOwnerExtras":"laborRecorded",
   basis.missingLaborDates,{covered,total:basis.elapsedOpenDates.length,
     planned:basis.openDates.length});
 const missing=[
   ...(basis.missingBills?["monthlyBillsPartial"]:[]),
   ...(basis.monthlyStaffCents===null?[mode==="today"?"todayLaborUnavailable":"monthlyLabor"]:[]),
   ...(laborPartial?["laborDaysIncomplete"]:[]),
   ...(basis.ingredientMissing?["ingredientRateMissing:ask_owner"]:[]),
   ...(basis.missingFees?["processingFeeDaysIncomplete"]:[]),
   ...(amount===null?["breakEvenUnavailable"]:[]),
 ];
 const feeActual=basis.historicalFeeBasis==="actual";
 const ingredientRate=calc.kind==="ready"?calc.ingredientRate:null;
 const feeRate=calc.kind==="ready"?calc.processingFeeRate:null;
 const status=amount===null?"missing":basis.estimatesUsed?"estimate":"actual";
 // Never classify an estimated TAX or future LABOR amount as estimated Toast fees.
 const reason=missing.length?"breakEvenKnownInputs":
   status==="actual"?"laborRecorded":"breakEvenEstimate";
 const reasonParams={missing:missing.join(", "),covered,total:basis.elapsedOpenDates.length};
 const explain:ExplainLine[]=amount!==null&&calc.kind==="ready"?[{
   label:mode==="today"?"Today's break-even sales":
     mode==="month_to_date"?"Month-to-date break-even sales":"Monthly break-even sales",
   inputs:[
     {name:"billsForPeriod",value:money(calc.monthlyBillsCents)},
     {name:"loadedLaborForPeriod",value:money(calc.monthlyStaffCents)},
     {name:"observedNetSales",value:money(basis.observedSalesCents)},
     {name:"ingredientCostCalibration",value:money(basis.observedIngredientCents)},
     {name:"feeCalibrationForScenario",value:money(basis.observedFeesCents)},
   ],
   formula:"breakEven",result:money(amount),period,
   source:"get_break_even",provenance:status==="actual"?"recorded":"estimate",
   basis:status==="actual"?"actual":"projected",
 }]:[];
 return {
   source:"break_even",period,periodKind:mode,agentId:"leo",
   monthlyBreakEvenCents:mode==="month_forecast"?amount:null,
   periodBreakEvenCents:amount,
   knownCostBreakEvenFloorCents:missing.length&&amount!==null?
     amount:basis.shared.knownCostFloorCents,
   dailyBreakEvenCents:daily,openDaysPerMonth:basis.openDayCount,
   periodOpenDays:basis.targetOpenDays,openDaysSource,
   drinksPerDay:basis.shared.drinksPerDay,
   observedProcessingFeesCents:basis.feeResult.amountCents,
   scenarioProcessingFeesCents:basis.observedFeesCents,
   observedIngredientCents:basis.observedIngredientCents,
   monthlyBills:{...bills,reasonKey:bills.reason,
     reason:localizedMetricReason(bills.reason,locale)},
   monthlyLabor:{...staff,reasonKey:staff.reason,
     reason:localizedMetricReason(staff.reason,locale,staff.reasonParams)},
   ingredientRate,ingredientStatus:basis.ingredientStatus,feeRate,
   feeStatus:feeActual?"actual":"estimate",
   historicalFeeCoverage:{actualDays:basis.historicalActualFeeDays,
     estimatedDays:basis.historicalEstimatedFeeDays,
     source:feeActual?"toast_actual":"estimated"},
   costProvenance:{
     wages:mode==="today"&&!basis.todayLaborReady?"missing":
       laborPartial?"partial":"toast_actual",
     employerPayrollTax:taxEstimated?"saved_rate_estimate":"recorded",
     futureLabor:mode==="month_forecast"&&laborForecast?"projected":"not_projected",
     historicalProcessingFees:feeActual?"toast_actual":"estimated",
     futureProcessingFeeRate:basis.feeRateOverridden?"owner_override":
       feeActual?"projected_from_actual":"estimate",
     ingredients:basis.ingredientSource,
     bills:basis.ownerBillsOverride?"owner_override":
       basis.missingBills?"partial":basis.estimatedBills?"estimated":"recorded",
   },
   status,reasonKey:reason,reason:localizedMetricReason(reason,locale,reasonParams),
   missingDays:basis.missingLaborDates,missing,
   laborCoverage:{from:period.from,
     to:mode==="month_forecast"?(basis.elapsedOpenDates.at(-1)??period.from):basis.periodEnd,
     covered:mode==="today"?(basis.todayLaborReady?1:0):covered,
     total:mode==="today"?1:basis.elapsedOpenDates.length,
     missingDates:basis.missingLaborDates},
   salesCalibration:{from:shiftCafeDate(asOf,-28),to:shiftCafeDate(asOf,-1),
     covered:basis.shared.coveredDays,expected:basis.shared.expectedDays},
   estimated:[
     ...(laborForecast?["monthlyLaborProjection"]:[]),
     ...(taxEstimated?["employerTaxFromSavedRate"]:[]),
     ...(!feeActual?["historicalProcessingFeeEstimate"]:[]),
     ...(basis.feeRateOverridden?["ownerProcessingFeeOverride"]:
       feeActual?["futureFeeRateProjectedFromActual"]:[]),
     ...(basis.estimatedBills?["monthlyBillsEstimate"]:[]),
     ...(basis.ownerBillsOverride?["ownerBillsOverride"]:[]),
     ...(basis.productCosts.usesEstimatedProductCosts?["productCostEstimate"]:[]),
     ...(basis.ingredientSource==="saved_rate"?["savedIngredientRate"]:[]),
   ],
   explain,
   numberEstimates:[
     ...(amount===null?[]:[{value:amount,unit:"cents" as const,detail:"breakEvenSales"}]),
     ...(daily===null?[]:[{value:daily,unit:"cents" as const,detail:"breakEvenSales"}]),
     ...(calc.kind==="ready"?[{value:calc.fixedMonthlyCostsCents,
       unit:"cents" as const,detail:"dailyOverhead"}]:[]),
   ],
 };
}

export const moneyTools={
  get_expenses:{
    agentId:"leo",schema:period.extend({category:z.string().max(100).nullable()}),description:"Recorded actual expenses separately from recurring category estimates.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=period.extend({category:z.string().max(100).nullable()}).parse(raw);
      if(!ctx.timezone)return unavailable("expenses",null,["cafeTimezoneMissing"]);
      const chosen=resolveOwnerPeriod(input.period,{asOf:ctx.asOf,timezone:ctx.timezone},ctx.resolveState);
      if(chosen.status!=="resolved")return periodChoicePayload("expenses",chosen);
      const p={from:chosen.value.from,to:chosen.value.to};
      if(!ctx.tools.getRecordedExpenses||!ctx.tools.getExpenseSummary)return unavailable("expenses",p,["expenseReaderUnavailable"]);
      const [recorded,categories]=await Promise.all([ctx.tools.getRecordedExpenses(p),ctx.tools.getExpenseSummary(p)]);
      // A named-category request must never silently become an all-expenses
      // request when the category reader fails.
      if(input.category&&!categories.available)return {
        source:"expenses",period:p,agentId:"leo",
        missing:categories.quality.missingInputs.length?categories.quality.missingInputs:["categoryReaderUnavailable"],
        recordedActualTotalCents:null,categories:null,
      };
      let filterCategory:string|null=null;
      if(input.category&&categories.available){
        const chosen=categories.value.find(item=>item.categoryCode.toLowerCase()===input.category?.toLowerCase()&&
          ctx.resolveState?.chosenIds.has(item.categoryCode.toLowerCase()));
        if(chosen)filterCategory=chosen.categoryCode;
        else {
          const selected=resolveEntity("category",input.category,categories.value,{
            nameOf:c=>c.label,idOf:c=>c.categoryCode,describe:c=>c.categoryCode});
          if(selected.status!=="resolved")return {...choicePayload(selected,"expenses",p),agentId:"leo"};
          filterCategory=selected.value.categoryCode;
        }
      }
      return {source:"expenses",period:p,agentId:"leo",
        missing:[...recorded.quality.missingInputs,...categories.quality.missingInputs,
          ...(filterCategory?["categoryRecordedActualTotalUnavailable"]:[])],
        // The recorded expense total covers ALL categories. Never present it as
        // the selected category's spend.
        recordedActualTotalCents:filterCategory?null:recorded.available?recorded.value.totalCents:null,
        categories:categories.available?categories.value.filter(c=>filterCategory===null||filterCategory===c.categoryCode).slice(0,15).map(v=>({
          label:v.label,categoryCode:v.categoryCode,amountCents:v.isMissing?null:v.amountCents,
          isEstimate:v.isEstimate,isMissing:v.isMissing})):null};
    },
  },
  get_bills:{
    agentId:"leo",schema:empty,description:"Configured monthly-equivalent recurring bills, not actual cash spent.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      empty.parse(raw);
      if(!ctx.tools.getMonthlyBills)return unavailable("recurring_bills",null,["billsReaderUnavailable"]);
      const s=await ctx.tools.getMonthlyBills();
      return {source:"recurring_bills",period:null,agentId:"leo",missing:s.quality.missingInputs,
        monthlyEquivalentCents:s.available?s.value.totalCents:null,estimated:s.quality.estimatedInputs.length>0};
    },
  },
  get_cashflow_evidence:{
    agentId:"leo",schema:z.strictObject({statementUploadId:z.uuid().nullable().optional(),rowOffset:z.number().int().nonnegative().max(10000).nullable().optional()}),
    description:"Dated cash, invoice claims, settlement allocations, recurring dates. Optional statementUploadId for source rows; rowOffset pages. Not live cash/unpaid debt.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const selection=z.strictObject({statementUploadId:z.uuid().nullable().optional(),rowOffset:z.number().int().nonnegative().max(10000).nullable().optional()}).parse(raw);
      const base={source:"cashflow_evidence",period:null,agentId:"leo" as const,
        asOf:ctx.timezone?ctx.asOf:null,currency:ctx.currency??null,
        availableCashCents:null,outstandingPaymentCents:null,settledPaymentCents:null,
        expectedDepositsCents:null,documentedAccountBalances:[]};
      const missing=["currentCashEvidenceMissing","expectedDepositEvidenceMissing"];
      if(!ctx.financialEvidenceRead||!ctx.timezone)return {...base,recordedClaimCount:null,
        recordedClaimTotalsByCurrency:[],claims:[],missing:[...missing,"supplierInvoiceEvidenceUnavailable"]};
      try{
        const evidence=await ctx.financialEvidenceRead(selection);
        return {...base,...evidence,missing:[...missing,...evidence.missing]};
      }catch{
        return {...base,recordedClaimCount:null,recordedClaimTotalsByCurrency:[],claims:[],
          missing:[...missing,"supplierInvoiceEvidenceUnavailable"]};
      }
    },
  },
  propose_financial_settlement:{
    agentId:"leo",schema:financialSettlementInputSchema,
    description:"Draft documentary debit allocation or credit reversal for exact invoice revision and statement row; owner confirms. No money movement or unverified paid claim.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const input=financialSettlementInputSchema.parse(raw);
      if(!ctx.financialSettlementPropose)return {source:"supplier_purchase_proposal",period:null,agentId:"leo",missing:["financialSettlementUnavailable"],draft:false,paymentMade:false};
      return {source:"supplier_purchase_proposal",proposalKind:"financial_settlement",period:null,agentId:"leo",
        missing:[],draft:true,saved:false,approvalRequired:true,paymentMade:false,...await ctx.financialSettlementPropose(input)};
    },
  },
  get_break_even:{
    agentId:"leo",schema:breakEvenInput,description:"Canonical Money/Plan break-even. month forecasts full month; month_to_date uses elapsed wages/prorated bills, never future labor; today uses today's costs, not monthly average. Quote periodBreakEvenCents for today/MTD, monthlyBreakEvenCents for month, dailyBreakEvenCents per open day. Historical Toast fees may be actual; future rates/payroll tax may be estimates. Reuse saved ingredient rate. Never re-ask imported wages/fees or returned inputs. Only explicit owner overrides; never recalculate.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const owner=breakEvenInput.parse(raw),provided=owner.ownerInputs;
      if(ctx.readEconomics){
        const {economics,canonicalBreakEven,canonicalSnapshot}=await ctx.readEconomics();
       // All production period and owner-input scenarios start with the SAME
       // authenticated business snapshot as Money and Plan, never unifiedBreakEven.
       if(canonicalSnapshot){
         const mode:BreakEvenPeriodMode=owner.period==="today"?"today":
           owner.period==="month_to_date"?"month_to_date":"month_forecast";
         const saved=canonicalBreakEven??breakEvenSnapshotInputs(canonicalSnapshot);
         const ownerLaborPeriod=provided?.laborPeriod?ownerPeriod(provided.laborPeriod,ctx.asOf):null;
         const targetPeriod=mode==="today"?{from:ctx.asOf,to:ctx.asOf}:
           mode==="month_to_date"?{from:calendarMonth(ctx.asOf).from,
             to:breakEvenSnapshotInputs(canonicalSnapshot,{period:mode}).periodEnd}:
             calendarMonth(ctx.asOf);
         // Use a single calendar prorate from the OWNER'S original period to
         // this answer's exact period. Do not convert to month and then
         // divide by open days: that inflates an exact $100 today statement.
         const suppliedPeriodLabor=provided?.laborCents!=null&&ownerLaborPeriod?
           prorate(provided.laborCents,ownerLaborPeriod,targetPeriod):undefined;
         const ownerSales=owner.ownerNetSalesCents??provided?.netSalesCents??undefined;
         const costPeriod=ownerPeriod(provided?.overheadPeriod??null,ctx.asOf)??calendarMonth(ctx.asOf);
         const ownerRent=provided?.rentCents==null?undefined:
           prorate(provided.rentCents,costPeriod,calendarMonth(ctx.asOf));
         const ownerOther=provided?.otherOverheadCents==null?undefined:
           prorate(provided.otherOverheadCents,costPeriod,calendarMonth(ctx.asOf));
         const options:BreakEvenInputOptions={period:mode,
           ...(owner.ownerIngredientPackagingPercent!=null&&
             (saved.ingredientStatus!=="owner"||
              saved.ingredientSource!=="saved_rate"||
              Math.abs((saved.shared.calculation.kind==="ready"?
                saved.shared.calculation.ingredientRate:0)-owner.ownerIngredientPackagingPercent/100)>1e-9)
             ?{ingredientRateOverride:owner.ownerIngredientPackagingPercent/100}:{}),
           ...(owner.ownerProcessingFeePercent!=null?
             {feeRateOverride:owner.ownerProcessingFeePercent/100}:{}),
           ...(ownerSales!==undefined?{observedSalesCentsOverride:ownerSales}:{}),
           ...(suppliedPeriodLabor!==undefined?{periodLaborCentsOverride:suppliedPeriodLabor}:{}),
           ...(ownerRent!==undefined?{monthlyRentCentsOverride:ownerRent}:{}),
           ...(ownerOther!==undefined?{monthlyOtherOverheadCentsOverride:ownerOther}:{}),
           ...(owner.ownerOpenDaysPerMonth!=null?{openDaysOverride:owner.ownerOpenDaysPerMonth}:{})
         };
         return canonicalBreakEvenAnswer(breakEvenSnapshotInputs(canonicalSnapshot,options),
           ctx.asOf,ctx.locale,economics.openDaysBasis??"calendar");
       }
       // A precomputed canonical core result is the same one-path monetary answer.
       // It can support a standard monthly read without requiring the entire
       // underlying snapshot. Never silently ignore an owner what-if or treat
       // today's/MTD calculations as a month-average result.
       const noOverrides=owner.ownerNetSalesCents==null&&owner.ownerSalesDays==null&&
         owner.ownerIngredientPackagingPercent==null&&owner.ownerProcessingFeePercent==null&&
         owner.ownerOpenDaysPerMonth==null&&provided==null;
       if(canonicalBreakEven&&noOverrides&&
          (owner.period==null||owner.period==="month")){
         return canonicalBreakEvenAnswer(canonicalBreakEven,ctx.asOf,ctx.locale,
           economics.openDaysBasis??"calendar");
       }
      }
      // A missing canonical snapshot is missing financial evidence, not permission
      // to run an alternate break-even formula or synthesize fixed daily costs.
      const mode=owner.period==="today"?"today":
        owner.period==="month_to_date"?"month_to_date":"month";
      const month=calendarMonth(ctx.asOf);
      return {source:"break_even",agentId:"leo",
        period:mode==="today"?{from:ctx.asOf,to:ctx.asOf}:
          mode==="month_to_date"?{from:month.from,to:ctx.asOf}:month,
        monthlyBreakEvenCents:null,periodBreakEvenCents:null,
        dailyBreakEvenCents:null,status:"missing",explain:[],
        missing:["canonicalBreakEvenUnavailable"]};

    },
  },
  get_cost_summary:{
    agentId:"leo",schema:period,description:"Observed business cost components; respect incomplete coverage.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      if(!ctx.timezone)return unavailable("business_costs",null,["cafeTimezoneMissing"]);
      const chosen=resolveOwnerPeriod(period.parse(raw).period,{asOf:ctx.asOf,timezone:ctx.timezone},ctx.resolveState);
      if(chosen.status!=="resolved")return periodChoicePayload("business_costs",chosen);
      const p={from:chosen.value.from,to:chosen.value.to};
      if(!ctx.tools.getBusinessCostSummary)return unavailable("business_costs",p,["costSummaryReaderUnavailable"]);
      const s=await ctx.tools.getBusinessCostSummary(p);
      const costs=[s.components.ingredientsCents,s.components.loadedStaffCents,
        s.components.cardFeesCents,s.components.runningCostsCents];
      const sum=safeSumCents(costs);
      const explain=s.completeness==="complete"&&
        Object.values(s.observed).every(Boolean)&&sum===s.knownTotalCents?
        [{label:{en,es,ar}[ctx.locale].MetricsNotes.itemRecordedBusinessCosts,inputs:[
          {name:{en,es,ar}[ctx.locale].MetricsNotes.itemInputsIngredients,value:money(costs[0])},{name:{en,es,ar}[ctx.locale].MetricsNotes.itemInputsLabor,value:money(costs[1])},
          {name:{en,es,ar}[ctx.locale].MetricsNotes.itemInputsFee,value:money(costs[2])},{name:{en,es,ar}[ctx.locale].MetricsNotes.itemInputsBills,value:money(costs[3])}],
          formula:"sum" as const,result:money(s.knownTotalCents),period:p,source:"get_cost_summary",
          provenance:s.estimatedInputs.length?"estimate" as const:"recorded" as const}]:[];
      return {source:"business_costs",period:p,agentId:"leo",missing:s.missingInputs,explain,
        completeness:s.completeness,knownTotalCents:s.completeness==="unavailable"?null:s.knownTotalCents,
        // The deterministic cost engine uses zero sentinels for unknown components.
        // Never allow those sentinels to masquerade as observed zero-cost amounts.
        components:{
          ingredientsCents:s.observed.ingredients?s.components.ingredientsCents:null,
          loadedStaffCents:s.observed.loadedStaff?s.components.loadedStaffCents:null,
          cardFeesCents:s.observed.cardFees?s.components.cardFeesCents:null,
          runningCostsCents:s.observed.runningCosts?s.components.runningCostsCents:null,
        },observed:s.observed,estimated:s.estimatedInputs,
        coverage:{salesDays:s.coverage.salesDays,laborDays:s.coverage.laborDays,
          expectedDays:s.coverage.expectedDays,missingProductCostCount:s.coverage.missingProductCostCount,
          itemSalesCovered:s.coverage.itemSalesCovered}};
    },
  },
} as const;
