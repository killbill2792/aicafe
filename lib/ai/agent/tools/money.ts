import { z } from "zod";
import type { AgentToolContext, AgentToolResult } from "./index";
import { requestedPeriod } from "./index";

const period=z.strictObject({period:z.enum(["today","week","month"])});
const empty=z.strictObject({});
const unavailable=(source:string,period:{from:string;to:string}|null,missing:string[]):AgentToolResult=>
  ({source,period,agentId:"leo",missing:missing.length?missing:["sourceUnavailable"]});
export const moneyTools={
  get_expenses:{
    agentId:"leo",schema:period,description:"Recorded actual expenses separately from recurring category estimates.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const p=requestedPeriod(period.parse(raw).period,ctx.asOf);
      if(!ctx.tools.getRecordedExpenses||!ctx.tools.getExpenseSummary)return unavailable("expenses",p,["expenseReaderUnavailable"]);
      const [recorded,categories]=await Promise.all([ctx.tools.getRecordedExpenses(p),ctx.tools.getExpenseSummary(p)]);
      return {source:"expenses",period:p,agentId:"leo",
        missing:[...recorded.quality.missingInputs,...categories.quality.missingInputs],
        recordedActualTotalCents:recorded.available?recorded.value.totalCents:null,
        categories:categories.available?categories.value.slice(0,15).map(v=>({
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
    agentId:"leo",schema:empty,description:"Deterministic drinks-to-break-even estimate and prerequisite quality.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      empty.parse(raw);
      if(!ctx.tools.getBreakEven)return unavailable("break_even",null,["breakEvenReaderUnavailable"]);
      const s=await ctx.tools.getBreakEven();
      return {source:"break_even",period:null,agentId:"leo",missing:s.quality.missingInputs,
        estimate:s.available?s.value:null};
    },
  },
  get_cost_summary:{
    agentId:"leo",schema:period,description:"Observed business cost components; respect incomplete coverage.",
    execute:async(raw:unknown,ctx:AgentToolContext):Promise<AgentToolResult>=>{
      const p=requestedPeriod(period.parse(raw).period,ctx.asOf);
      if(!ctx.tools.getBusinessCostSummary)return unavailable("business_costs",p,["costSummaryReaderUnavailable"]);
      const s=await ctx.tools.getBusinessCostSummary(p);
      return {source:"business_costs",period:p,agentId:"leo",missing:s.missingInputs,
        completeness:s.completeness,knownTotalCents:s.completeness==="unavailable"?null:s.knownTotalCents,
        components:s.components,observed:s.observed,estimated:s.estimatedInputs,
        coverage:{salesDays:s.coverage.salesDays,laborDays:s.coverage.laborDays,
          expectedDays:s.coverage.expectedDays,missingProductCostCount:s.coverage.missingProductCostCount,
          itemSalesCovered:s.coverage.itemSalesCovered}};
    },
  },
} as const;
