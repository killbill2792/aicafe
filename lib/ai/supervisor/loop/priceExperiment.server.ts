import "server-only";
import {simulationOwnerReader} from "./simulationOwner.server";
import {z} from "zod";
import {diffFieldSchema,diffFields} from "@/lib/format/values";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {getMenuControlCenter} from "@/lib/data/getMenuControlCenter";
import {ToolError} from "@/lib/ai/agent/toolErrors";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {formatCardValue} from "@/lib/format/values";
import {evaluatePriceExperiment,simulatePriceExperiment,priceExperimentEstimatedUplift,
  type PriceExperimentBaseline,type PriceExperimentDay} from "@/lib/calc/priceExperiment";
import {readPriceExperimentBaselineUnits,readPriceExperimentSalesDays} from "./sales.server";
import {registerLoopCapability,loopRegistry} from "./engine";
import {menuPriceChangeCapability} from "./menuPriceChange.server";
import {staffCapabilities} from "./staffProposals.server";
import {purchaseCapability} from "./purchases.server";
import {goalCapability} from "./goal.server";
import {eventReadinessCapability} from "./eventReadiness.server";
import {readMetricDay} from "@/lib/data/metricDay.server";
import {computeMetric} from "@/lib/calc/metrics/catalog";
import {addDays} from "@/lib/calc/goals/goalSpec";
import {cafeOrdersSchema,ordersGuardrail,type CafeOrdersReading} from "@/lib/calc/priceExperimentGuardrail";

/** Certified café orders for the day and the same weekday 7 and 14 days earlier.
 * null when the reading fails: the guardrail is a warning, never a blocker. */
async function readCafeOrders(businessId:string,date:string):Promise<CafeOrdersReading|null>{
  const orders=async(d:string)=>computeMetric("orders",{},await readMetricDay(businessId,d,
    {items:false,hours:false,ingredientIds:[],itemIds:[],costs:false})).value;
  try{
    const [value,w1,w2]=await Promise.all([orders(date),orders(addDays(date,-7)),orders(addDays(date,-14))]);
    return {value,baseline:[{date:addDays(date,-7),value:w1},{date:addDays(date,-14),value:w2}]};
  }catch{return null;}
}

const cents=z.number().int().safe().nonnegative();
const baseline=z.strictObject({
  productId:z.uuid(),productName:z.string().min(1).max(200),
  oldPriceCents:cents,newPriceCents:cents,ingredientCostCents:cents,
  baselineUnits7Days:cents,currency:z.string().regex(/^[A-Z]{3}$/),
  estimateKind:z.literal("conditional_unchanged_demand"),preview:z.array(diffFieldSchema).optional(),
});
export const priceExperimentCapabilityId="alex.drink_price_experiment.v1";
export const priceExperimentCapability=registerLoopCapability({
  id:priceExperimentCapabilityId,version:1,
  inputSchema:z.strictObject({productId:z.uuid(),increaseCents:cents.positive().max(100000)}),
  proposalDescription:"Only when the owner clearly REQUESTS to try/test a specific real drink price increase, or unambiguously confirms the single price trial in their prior message, prepare an inert owner-review proposal. For mere hypothetical questions use read/simulate tools instead. Never approve, commit, change POS prices, or claim an action happened. Read the menu catalog to find an actual product UUID. Match the owner-authored cent increase exactly; ask clarification for ambiguous sizes or amounts. Understand English, Spanish and Arabic.",
  effectSchema:baseline,
  dependencyScope:(effect)=>({version:2,kind:"menu_price",productId:effect.productId}),
  simulate:async(scope,input)=>{
    // Existing canonical UI read model has recipe-cost quality + covered item sales.
    const {client,explicit}=await simulationOwnerReader(scope);
    const {data:business}=await client.from("businesses").select("currency,is_demo").eq("id",scope.businessId).maybeSingle();
    if(!business||business.is_demo)throw new ToolError("unauthorized");
    // Any café currency works; an unset or invalid currency cannot label money.
    const currency=typeof business?.currency==="string"&&/^[A-Z]{3}$/.test(business.currency)?business.currency:null;
    if(!currency)throw new ToolError("validation","Set your café currency in Café profile before starting a price experiment.");
    const matches=(await (explicit?getMenuControlCenter({},{client,businessId:scope.businessId}):getMenuControlCenter())).filter(x=>x.active&&x.id===input.productId);
    if(matches.length!==1)throw new ToolError("not_found");
    const item=matches[0];
    const verifiedUnits=await readPriceExperimentBaselineUnits(scope.businessId,item.id,explicit?client:undefined);
    const result=simulatePriceExperiment({productId:item.id,productName:item.name,
      currentPriceCents:item.priceCents,increaseCents:input.increaseCents,
      ingredientCostCents:item.pricing?.productCostCents??null,
      units7Days:verifiedUnits,currency});
    if(!result)throw new ToolError("validation","This experiment needs covered sales and a known recipe cost. Add those facts and try again.");
    const {beforeContributionCents,afterContributionCents,
      estimatedAdditionalRevenue7DaysCents,estimatedAdditionalContribution7DaysCents,...effect}=result;
    const preview=[
      ...diffFields([{field:"price",label:"Price",value:{kind:"money",cents:effect.oldPriceCents}}],
        [{field:"price",label:"Price",value:{kind:"money",cents:effect.newPriceCents}}]),
      ...diffFields([], [{field:"duration",label:"Duration",value:{kind:"count",n:7,unit:"days"}}] as const),
    ];
    return {effect:{...effect,preview},baseline:{beforeContributionCents,afterContributionCents,
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
    const cafeOrders=await readCafeOrders(scope.businessId,businessDate);
    return {businessDate,observation:{...day,...(cafeOrders?{cafeOrders}:{})},source:day.source};
  },
  report:async(_scope,effect,samples,windowComplete)=>{
    const observed:PriceExperimentDay[]=samples.map(s=>{
      const d=s.observation;
      return {businessDate:s.businessDate,units:Number(d.units),
        netSalesCents:Number(d.netSalesCents),
        coverage:d.coverage==="actual"?"actual":"unavailable",source:s.source};
    });
    const evaluated=evaluatePriceExperiment(effect as PriceExperimentBaseline,observed,7);
    const guard=ordersGuardrail(samples.map(s=>{
      const r=cafeOrdersSchema.safeParse(s.observation.cafeOrders);
      return r.success?r.data:null;
    }));
    // Fewer customers overall outweighs a better item number: never "keep" then.
    const measured=guard.status==="broken"&&evaluated.recommendation==="keep"
      ?{...evaluated,recommendation:"adjust" as const}:evaluated;
    // A terminal, partially covered window is insufficient evidence, not
    // an ongoing trial. Use the SAME finalized status in every domain-owned
    // delivery surface (Operations payload, source facts, and thread report).
    const result=windowComplete&&measured.status==="in_progress"
      ?{...measured,status:"insufficient_evidence" as const}:measured;
    const copy=({en,es,ar} as const)[_scope.locale].SupervisorExperiment;
    const money=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)
      ?formatCardValue({kind:"money",cents:v},_scope.locale,effect.currency)
      :copy.notAvailable;
    const recommendation=result.recommendation==="keep"?copy.keep:
      result.recommendation==="revert"?copy.revert:copy.adjust;
    const estimatedUplift=priceExperimentEstimatedUplift(effect);
    const trial={...result,baselineUnits7Days:effect.baselineUnits7Days,
      oldPriceCents:effect.oldPriceCents,newPriceCents:effect.newPriceCents,
      productName:effect.productName,
      estimatedAdditionalRevenue7DaysCents:estimatedUplift};
    const pct=(v:number,signed:boolean)=>new Intl.NumberFormat(_scope.locale,{maximumFractionDigits:1,
      signDisplay:signed?"exceptZero":"never"}).format(v);
    // Always say how many days the orders comparison covered; never imply a
    // whole-test result from a few comparable days.
    const n=(v:number)=>new Intl.NumberFormat(_scope.locale).format(v);
    const coverage=(t:string)=>t.replace("{counted}",n(guard.countedDays)).replace("{total}",n(samples.length));
    const guardText=guard.status==="broken"
      ?coverage(copy.guardrailBroken.replace("{change}",pct(guard.changePct,false))
        .replace("{now}",n(guard.ordersNow)).replace("{before}",n(guard.ordersBefore)))
      :guard.status==="ok"?coverage(copy.guardrailOk.replace("{change}",pct(guard.changePct,true)))
      :samples.length>0?copy.guardrailUnknown:null;
    const text=[copy.reportThread,
      copy.reportTask.replace("{item}",effect.productName)+".",
      copy.reportOldPrice.replace("{value}",money(effect.oldPriceCents)),
      copy.reportNewPrice.replace("{value}",money(effect.newPriceCents)),
      copy.reportEstimated.replace("{value}",money(trial.estimatedAdditionalRevenue7DaysCents)),
      copy.reportRevenue.replace("{value}",money(trial.observedRevenueCents)),
      copy.reportDifference.replace("{value}",money(trial.realizedRevenueDifferenceCents)),
      copy.reportIngredientOnly.replace("{value}",money(trial.observedIngredientContributionCents)),
      ...(guardText?[guardText]:[]),
      copy.recommendation.replace("{choice}",recommendation),
      result.status==="complete"?copy.reportCompletedCaveat:copy.reportUncertain].join(" ");
    const count=(v:number)=>new Intl.NumberFormat(_scope.locale).format(v);
    const midRunText=windowComplete?undefined:result.coveredDays>0&&result.units!==null
      ?copy.midRunUpdate.replace("{item}",effect.productName).replace("{covered}",count(result.coveredDays))
        .replaceAll("{days}",count(7)).replace("{price}",money(effect.newPriceCents))
        .replace("{units}",count(result.units)).replace("{revenue}",money(result.observedRevenueCents))
        .replace("{difference}",money(result.realizedRevenueDifferenceCents))
      :copy.midRunNoData.replace("{item}",effect.productName).replace("{price}",money(effect.newPriceCents))
        .replaceAll("{days}",count(7));
    const midRun=midRunText&&guard.status==="broken"&&guardText?midRunText+" "+guardText:midRunText;
    return {status:result.status,result:trial,recommendation:result.recommendation,source:"order_lines",midRunText:midRun,
      delivery:{agentId:"alex" as const,taskKind:"price_experiment_report" as const,
        entityType:"menu_item",entityId:effect.productId,
        confidence:result.status==="complete"?"high" as const:"low" as const,
        payload:{itemName:effect.productName,recommendation:result.recommendation,
          outcomeStatus:result.status,observedRevenueCents:trial.observedRevenueCents,
          realizedRevenueDifferenceCents:trial.realizedRevenueDifferenceCents,
          observedIngredientContributionCents:trial.observedIngredientContributionCents,
          estimatedAdditionalRevenue7DaysCents:trial.estimatedAdditionalRevenue7DaysCents,
          estimateIsConditional:true,coveredDays:result.coveredDays,ordersGuardrail:guard.status,
          ordersChangePct:guard.status==="unknown"?null:guard.changePct,ordersComparedDays:guard.countedDays},
        evidence:[{source:"order_lines",facts:{coveredDays:result.coveredDays,
          status:result.status,nonCausal:true,ordersGuardrail:guard.status,ordersComparedDays:guard.countedDays}}],
        threadText:text},
    };
  },
});
export const supervisorLoopRegistry=loopRegistry(priceExperimentCapability,menuPriceChangeCapability,purchaseCapability,goalCapability,eventReadinessCapability,...staffCapabilities);
