import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {localizedMetricReason} from "@/lib/ai/agent/metricReasons";
import { z } from "zod";
import type { AgentToolContext, AgentToolResult } from "./index";
import { requestedPeriod } from "./period";
import {resolveOwnerPeriod,resolveEntity,choicePayload,periodChoicePayload} from "../resolve";
import {money,percent,count} from "../explain";
import {safeSumCents} from "@/lib/calc/explainMath";
import {ownerInputsSchema,ownerPeriod} from "./ownerInputs";
import {prorate,periodDays,calendarMonth} from "@/lib/calc/periods";
import { ownerReportedDailyBreakEven, recordedDailyFixedCosts, percentToBasisPoints } from "@/lib/calc/ownerReportedBreakEven";
import {figure,unifiedBreakEven} from "@/lib/calc/supervisorEconomics";

const period=z.strictObject({period:z.union([z.string().min(1).max(32),z.strictObject({preset:z.enum(["today","week","month","last_week","last_month","ytd"])}),z.strictObject({from:z.iso.date(),to:z.iso.date()})])});
const empty=z.strictObject({});
// Nullable for the Responses strict-tool schema. Omitted fields keep existing callers working.
const breakEvenInput=z.strictObject({
  ownerIngredientPackagingPercent:z.number().min(0).max(99.99).nullable().optional(),
  ownerProcessingFeePercent:z.number().min(0).max(99.99).nullable().optional(),
  ownerNetSalesCents:z.number().int().nonnegative().nullable().optional(),
  ownerSalesDays:z.number().int().positive().nullable().optional(),
  ownerInputs:ownerInputsSchema.nullable().optional(),
});
const unavailable=(source:string,period:{from:string;to:string}|null,missing:string[]):AgentToolResult=>
  ({source,period,agentId:"leo",missing:missing.length?missing:["sourceUnavailable"]});
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
  get_break_even:{
    agentId:"leo",schema:breakEvenInput,description:"Read recorded daily fixed costs and calculate break-even sales using the owner's ingredient+packaging percentage and their net sales/days when they supply them. Do not demand imported sales when the owner supplies net sales. Pass null for unknown owner inputs; never invent them. If processing-fee rate is unknown, still calculate but explicitly say this estimate excludes processing fees.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const owner=breakEvenInput.parse(raw),provided=owner.ownerInputs;
      if(ctx.readEconomics){
        const {economics}=await ctx.readEconomics();
        const overridden={...economics};
        // Owner-provided figures belong to this answer, never silently fall back
        // to the import window. No persistence or POS mutation is performed here.
        overridden.ownerNetSalesCents=owner.ownerNetSalesCents??provided?.netSalesCents??null;
        overridden.ownerSalesDays=owner.ownerSalesDays??null;
        if(provided?.laborCents!==null&&provided?.laborCents!==undefined&&provided.laborPeriod){
          const range=ownerPeriod(provided.laborPeriod,ctx.asOf);
          if(range)overridden.monthlyStaff=figure(prorate(provided.laborCents,range,calendarMonth(ctx.asOf)),
            "owner","owner_provided");
        }
        if(owner.ownerIngredientPackagingPercent!==null&&owner.ownerIngredientPackagingPercent!==undefined){
          overridden.ingredientRate=owner.ownerIngredientPackagingPercent/100;
          overridden.ingredientStatus="owner";
        }
        if(owner.ownerProcessingFeePercent!==null&&owner.ownerProcessingFeePercent!==undefined){
          overridden.feeRate=owner.ownerProcessingFeePercent/100;
          overridden.feeStatus="owner";
        }
        const result=unifiedBreakEven(overridden);
        const monthly=result.monthlyBreakEven.valueCents;
        return {source:"break_even",period:calendarMonth(ctx.asOf),agentId:"leo",
          monthlyBreakEvenCents:monthly,knownCostBreakEvenFloorCents:result.knownCostBreakEvenFloorCents,
          drinksPerDay:result.drinksPerDay,
          observedProcessingFeesCents:result.observedProcessingFeesCents,
          observedIngredientCents:result.observedIngredientCents,
          monthlyBills:{...result.monthlyBills,reasonKey:result.monthlyBills.reason,
            reason:localizedMetricReason(result.monthlyBills.reason,ctx.locale,result.monthlyBills.reasonParams)},
          monthlyLabor:{...result.monthlyStaff,reasonKey:result.monthlyStaff.reason,
            reason:localizedMetricReason(result.monthlyStaff.reason,ctx.locale,result.monthlyStaff.reasonParams)},
          ingredientRate:result.ingredientRate,feeRate:result.feeRate,
          status:result.status,reasonKey:result.reason,
           reason:localizedMetricReason(result.reason,ctx.locale,result.reasonParams),
           missingDays:overridden.missingDays,
          missing:result.missing,ownerInputs:provided??null,
          numberEstimates:[...(monthly===null?[]:[{value:monthly,unit:"cents" as const,detail:"breakEvenSales"}]),
            ...(result.knownCostBreakEvenFloorCents===null?[]:[{value:result.knownCostBreakEvenFloorCents,
              unit:"cents" as const,detail:"breakEvenSales"}]),
            ...(result.monthlyFixedKnownCents?[{value:result.monthlyFixedKnownCents,unit:"cents" as const,detail:"dailyOverhead"}]:[])],
        };
      }
      const knownOwnerLaborDailyCents=provided?.laborCents!=null&&provided.laborPeriod?
        prorate(provided.laborCents,ownerPeriod(provided.laborPeriod,ctx.asOf)!,{from:ctx.asOf,to:ctx.asOf}):null;
      const ownerPercent=owner.ownerIngredientPackagingPercent;
      const ownerBps=percentToBasisPoints(ownerPercent);
      const s=ctx.tools.getBreakEven?await ctx.tools.getBreakEven():null;
      let dailyFixedCostsCents=s?.available?s.value.dailyCostsToCoverCents:null;
      let costSource:"break_even"|"business_costs"="break_even";
      let fixedCostMissing:string[]=[];
      let fixedCostEstimates:string[]=[];
      // A successful break-even reader can still lack fixed cost coverage.
      // Owner-supplied sales replace POS sales, not unrecorded labor or bills.
      if(ownerBps!==null&&s?.available){
        const fixedMissing=s.quality.missingInputs.filter(key=>
          /(?:staff|labor|expense|bill|operating|runningCost|fixedCost)/iu.test(key));
        fixedCostEstimates=s.quality.estimatedInputs.filter(key=>
          /(?:staff|labor|expense|bill|operating|runningCost|fixedCost)/iu.test(key));
        if(fixedMissing.length){
          fixedCostMissing=fixedMissing;
          dailyFixedCostsCents=null;
        }
      }
      // Sales coverage is irrelevant when sales and the variable-cost rate
      // come from the owner. Fixed labor and operating-expense coverage are not.
      if(ownerBps!==null&&ctx.tools.getBusinessCostSummary){
        const costs=await ctx.tools.getBusinessCostSummary(requestedPeriod("month",ctx.asOf));
        const coverage=costs.coverage;
        // A non-missing fixed input can still be an assumption (estimated bill
        // or staff tax). Do not present that daily overhead as fully recorded.
        fixedCostEstimates=costs.estimatedInputs.filter(key=>
          /^(?:expense:|staffTax:|priorMonthRunningCostEstimate)/u.test(key));
        const operatingMissing=coverage.missingOperatingCategories.map(c=>"operatingExpense:"+c.code);
        fixedCostMissing=[
          ...(!costs.observed.loadedStaff?["staffCostsUnobserved"]:[]),
          ...(coverage.expectedDays<=0||coverage.laborDays<coverage.expectedDays?["laborDaysIncomplete"]:[]),
          ...(!costs.observed.runningCosts?["operatingCostsUnobserved"]:[]),
          ...operatingMissing,
          ...costs.missingInputs.filter(key=>!/(?:sales|ingredient|productCost|cardFee|processingFee|itemSales)/i.test(key)),
        ];
        fixedCostMissing=[...new Set(fixedCostMissing)];
        // An incomplete fixed-cost subtotal must not be divided by all days.
        dailyFixedCostsCents=null;
        if(costs.completeness!=="unavailable"&&fixedCostMissing.length===0&&coverage.expectedDays>0){
          dailyFixedCostsCents=recordedDailyFixedCosts({
            runningCostsCents:costs.components.runningCostsCents,
            loadedStaffCents:costs.components.loadedStaffCents,
            expectedDays:coverage.expectedDays,
          });
          if(dailyFixedCostsCents!==null)costSource="business_costs";
          else fixedCostMissing.push("recordedFixedCostsInvalid");
        }
        if(dailyFixedCostsCents===null&&fixedCostMissing.length===0)
          fixedCostMissing.push("recordedFixedCostsUnavailable");
      }
      // Add only the owner-entered amount explicitly identified as NOT covered
      // by connected wages, employer-tax rate, or imported payroll.
      const ownerPayroll=await ctx.tools.getOwnerMonthlyPayrollExtras?.();
      const ownerMonthlyPayrollExtrasCents=ownerPayroll?.available?
        ownerPayroll.value.monthlyCents:null;
      const ownerDailyPayrollExtrasCents=ownerMonthlyPayrollExtrasCents===null?null:
        Math.round(ownerMonthlyPayrollExtrasCents/periodDays(calendarMonth(ctx.asOf)));
      if(ownerDailyPayrollExtrasCents!==null&&dailyFixedCostsCents!==null){
        const total=dailyFixedCostsCents+ownerDailyPayrollExtrasCents;
        if(Number.isSafeInteger(total)){
          dailyFixedCostsCents=total;
          fixedCostEstimates=[...new Set([...fixedCostEstimates,"ownerMonthlyPayrollExtras"])];
        }else{
          dailyFixedCostsCents=null;fixedCostMissing.push("ownerMonthlyPayrollOverflow");
        }
      }
      const comparison=dailyFixedCostsCents!==null&&ownerBps!==null
        ? ownerReportedDailyBreakEven({
            dailyFixedCostsCents,
            ingredientPackagingBps:ownerBps,
            processingFeeBps:percentToBasisPoints(owner.ownerProcessingFeePercent),
            netSalesCents:owner.ownerNetSalesCents??provided?.netSalesCents,
            salesDays:owner.ownerSalesDays??(provided?.salesPeriod?
              periodDays(ownerPeriod(provided.salesPeriod,ctx.asOf)!):null),
          }):null;
      const ownerFiguresProvided=owner.ownerNetSalesCents!=null||provided?.netSalesCents!=null||
        owner.ownerSalesDays!=null||provided?.salesPeriod!=null||owner.ownerProcessingFeePercent!=null;
      const modelMissing=[
        ...(ownerFiguresProvided&&ownerBps===null?["ownerIngredientPackagingRateMissing"]:[]),
        ...((owner.ownerNetSalesCents!=null||provided?.netSalesCents!=null)&&owner.ownerSalesDays==null&&!provided?.salesPeriod?["ownerSalesDaysMissing"]:[]),
        ...(ownerBps!==null&&dailyFixedCostsCents!==null&&!comparison?["invalidContributionMargin"]:[]),
      ];
      const missing=[...new Set([
        ...(comparison?(comparison.processingFeesIncluded?[]:["processingFeeRateUnknown:estimateExcludesProcessingFees"]):
          fixedCostMissing.length?fixedCostMissing:s?.quality.missingInputs??["recordedFixedCostsUnavailable"]),
        ...modelMissing,
        ...(ownerMonthlyPayrollExtrasCents===null?
         ["ownerMonthlyPayrollExtrasNotSet:estimateExcludesUnknownAdditionalPayroll"]:[]),
      ])];
      const marginBps=ownerBps===null?null:
        10000-ownerBps-(percentToBasisPoints(owner.ownerProcessingFeePercent)??0);
      const breakEvenExplain=comparison&&marginBps!==null&&marginBps>0?[
        {label:"Daily break-even sales",inputs:[
          {name:"dailyFixedCosts",value:money(comparison.dailyFixedCostsCents)},
          {name:"contributionMargin",value:percent(marginBps)}],
         formula:"divide" as const,result:money(comparison.dailyBreakEvenSalesCents),
         period:null,source:"get_break_even",provenance:"ownerProvided" as const}]:[];
      return {source:"break_even",period:null,agentId:"leo",unit:"cents",
        ownerInputs:provided??null,knownOwnerLaborDailyCents,
        ownerMonthlyPayrollExtrasCents,
        ownerDailyPayrollExtrasCents,
        ownerMonthlyPayrollSource:ownerMonthlyPayrollExtrasCents===null?null:"owner_provided",
        ownerMonthlyPayrollStatus:ownerMonthlyPayrollExtrasCents===null?"missing":"estimated",
        // Owner-supplied labor alone is NOT verified full fixed-cost coverage.
        missing,explain:breakEvenExplain,
        ...(fixedCostEstimates.length?{estimated:fixedCostEstimates}:{}),
        estimate:s?.available?s.value:null,
        // Null-valued metric keys intentionally invalidate old numeric evidence
        // when an explicit recalculation is impossible or changes assumptions.
        ...(ownerBps!==null||ownerFiguresProvided?{
          ownerComparison:comparison??{
            dailyFixedCostsCents:null,
            dailyBreakEvenSalesCents:null,dailyShortfallCents:null,
          },
        }:{}),
        ...(comparison ? {
          ownerIngredientPackagingBps:ownerBps,
          ownerNetSalesCents:owner.ownerNetSalesCents??provided?.netSalesCents??null,
          ownerSalesDays:owner.ownerSalesDays??(provided?.salesPeriod?periodDays(ownerPeriod(provided.salesPeriod,ctx.asOf)!):null),
          ownerCostSource:costSource,
          // Mark modeled results as estimates, not raw recorded facts.
          numberEstimates:[
            {value:comparison.dailyBreakEvenSalesCents,unit:"cents",detail:"breakEvenSales"},
            ...(comparison.dailyShortfallCents===null?[]:[{value:comparison.dailyShortfallCents,
              unit:"cents",detail:"salesGap"}]),
            ...(fixedCostEstimates.length?[{value:comparison.dailyFixedCostsCents,
              unit:"cents",detail:"dailyOverhead"}]:[]),
          ],
        }:{}),
      };
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
          {name:"ingredients",value:money(costs[0])},{name:"staff",value:money(costs[1])},
          {name:"fees",value:money(costs[2])},{name:"overhead",value:money(costs[3])}],
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
