import "server-only";
import {z} from "zod";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {getMenuControlCenter} from "@/lib/data/getMenuControlCenter";
import {ToolError} from "@/lib/ai/agent/toolErrors";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {evaluatePriceExperiment,simulatePriceExperiment,priceExperimentEstimatedUplift,
  type PriceExperimentBaseline,type PriceExperimentDay} from "@/lib/calc/priceExperiment";
import {readPriceExperimentBaselineUnits,readPriceExperimentSalesDays} from "./sales.server";
import {registerLoopCapability,loopRegistry} from "./engine";
import {menuPriceChangeCapability} from "./menuPriceChange.server";
import {staffCapabilities} from "./staffProposals.server";

const cents=z.number().int().safe().nonnegative();
const baseline=z.strictObject({
  productId:z.uuid(),productName:z.string().min(1).max(200),
  oldPriceCents:cents,newPriceCents:cents,ingredientCostCents:cents,
  baselineUnits7Days:cents,currency:z.literal("USD"),
  estimateKind:z.literal("conditional_unchanged_demand"),
});
export const priceExperimentCapabilityId="alex.drink_price_experiment.v1";
export const priceExperimentCapability=registerLoopCapability({
  id:priceExperimentCapabilityId,version:1,
  inputSchema:z.strictObject({productId:z.uuid(),increaseCents:cents.positive().max(100000)}),
  proposalDescription:"Only when the owner clearly REQUESTS to try/test a specific real drink price increase, or unambiguously confirms the single price trial in their prior message, prepare an inert owner-review proposal. For mere hypothetical questions use read/simulate tools instead. Never approve, commit, change POS prices, or claim an action happened. Read the menu catalog to find an actual product UUID. Match the owner-authored cent increase exactly; ask clarification for ambiguous sizes or amounts. Understand English, Spanish and Arabic.",
  effectSchema:baseline,
  simulate:async(scope,input)=>{
    // Existing canonical UI read model has recipe-cost quality + covered item sales.
    const client=await createServerSupabaseClient();
    const {data:{user}}=await client.auth.getUser();
    if(!user||user.id!==scope.ownerUserId)throw new ToolError("unauthorized");
    if(await getActiveBusinessId(user.id)!==scope.businessId)throw new ToolError("scope_mismatch");
    const {data:membership}=await client.from("memberships").select("role").eq("business_id",scope.businessId).eq("user_id",user.id).maybeSingle();
    const {data:business}=await client.from("businesses").select("currency,is_demo").eq("id",scope.businessId).maybeSingle();
    if(membership?.role!=="owner"||business?.currency!=="USD"||business?.is_demo)throw new ToolError("unauthorized");
    const matches=(await getMenuControlCenter()).filter(x=>x.active&&x.id===input.productId);
    if(matches.length!==1)throw new ToolError("not_found");
    const item=matches[0];
    const verifiedUnits=await readPriceExperimentBaselineUnits(scope.businessId,item.id);
    const result=simulatePriceExperiment({productId:item.id,productName:item.name,
      currentPriceCents:item.priceCents,increaseCents:input.increaseCents,
      ingredientCostCents:item.pricing?.productCostCents??null,
      units7Days:verifiedUnits});
    if(!result)throw new ToolError("validation","This experiment needs covered sales and a known recipe cost. Add those facts and try again.");
    const {beforeContributionCents,afterContributionCents,
      estimatedAdditionalRevenue7DaysCents,estimatedAdditionalContribution7DaysCents,...effect}=result;
    return {effect,baseline:{beforeContributionCents,afterContributionCents,
      estimatedAdditionalRevenue7DaysCents,estimatedAdditionalContribution7DaysCents,
      source:"daily_rollups+order_lines",status:"estimated",assumption:"unchanged_unit_demand"},
      monitorSpec:{durationDays:7,metricScope:item.id}};
  },
  // POS menu APIs are READ-ONLY: no simulated side effect and no fake success.
  commit:async(_scope,effect)=>({status:"requires_manual_action",
    instructionKey:"update_price_in_pos",
    instructions:{productName:effect.productName,toPriceCents:String(effect.newPriceCents)}}),
  monitor:async(scope,effect,businessDate)=>{
    const observed=await readPriceExperimentSalesDays(scope.businessId,effect.productId,businessDate,1);
    const day=observed[0];
    if(!day)return null;
    return {businessDate,observation:{...day},source:day.source};
  },
  report:async(_scope,effect,samples,windowComplete)=>{
    const observed:PriceExperimentDay[]=samples.map(s=>{
      const d=s.observation;
      return {businessDate:s.businessDate,units:Number(d.units),
        netSalesCents:Number(d.netSalesCents),
        coverage:d.coverage==="actual"?"actual":"unavailable",source:s.source};
    });
    const measured=evaluatePriceExperiment(effect as PriceExperimentBaseline,observed,7);
    // A terminal, partially covered window is insufficient evidence, not
    // an ongoing trial. Use the SAME finalized status in every domain-owned
    // delivery surface (Operations payload, source facts, and thread report).
    const result=windowComplete&&measured.status==="in_progress"
      ?{...measured,status:"insufficient_evidence" as const}:measured;
    const copy=({en,es,ar} as const)[_scope.locale].SupervisorExperiment;
    const money=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)
      ?new Intl.NumberFormat(_scope.locale,{style:"currency",currency:"USD"}).format(v/100)
      :copy.notAvailable;
    const recommendation=result.recommendation==="keep"?copy.keep:
      result.recommendation==="revert"?copy.revert:copy.adjust;
    const estimatedUplift=priceExperimentEstimatedUplift(effect);
    const trial={...result,baselineUnits7Days:effect.baselineUnits7Days,
      oldPriceCents:effect.oldPriceCents,newPriceCents:effect.newPriceCents,
      productName:effect.productName,
      estimatedAdditionalRevenue7DaysCents:estimatedUplift};
    const text=[copy.reportThread,
      copy.reportTask.replace("{item}",effect.productName)+".",
      copy.reportOldPrice.replace("{value}",money(effect.oldPriceCents)),
      copy.reportNewPrice.replace("{value}",money(effect.newPriceCents)),
      copy.reportEstimated.replace("{value}",money(trial.estimatedAdditionalRevenue7DaysCents)),
      copy.reportRevenue.replace("{value}",money(trial.observedRevenueCents)),
      copy.reportDifference.replace("{value}",money(trial.realizedRevenueDifferenceCents)),
      copy.reportIngredientOnly.replace("{value}",money(trial.observedIngredientContributionCents)),
      copy.recommendation.replace("{choice}",recommendation),
      result.status==="complete"?copy.reportCompletedCaveat:copy.reportUncertain].join(" ");
    return {status:result.status,result:trial,recommendation:result.recommendation,source:"order_lines",
      delivery:{agentId:"alex" as const,taskKind:"price_experiment_report" as const,
        entityType:"menu_item",entityId:effect.productId,
        confidence:result.status==="complete"?"high" as const:"low" as const,
        payload:{itemName:effect.productName,recommendation:result.recommendation,
          outcomeStatus:result.status,observedRevenueCents:trial.observedRevenueCents,
          realizedRevenueDifferenceCents:trial.realizedRevenueDifferenceCents,
          observedIngredientContributionCents:trial.observedIngredientContributionCents,
          estimatedAdditionalRevenue7DaysCents:trial.estimatedAdditionalRevenue7DaysCents,
          estimateIsConditional:true,coveredDays:result.coveredDays},
        evidence:[{source:"order_lines",facts:{coveredDays:result.coveredDays,
          status:result.status,nonCausal:true}}],
        threadText:text},
    };
  },
});
export const supervisorLoopRegistry=loopRegistry(priceExperimentCapability,menuPriceChangeCapability,...staffCapabilities);
