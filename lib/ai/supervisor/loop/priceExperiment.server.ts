import "server-only";
import {z} from "zod";
import {getMenuControlCenter} from "@/lib/data/getMenuControlCenter";
import {evaluatePriceExperiment,simulatePriceExperiment,
  type PriceExperimentBaseline,type PriceExperimentDay} from "@/lib/calc/priceExperiment";
import {readPriceExperimentBaselineUnits,readPriceExperimentSalesDays} from "./sales.server";
import {registerLoopCapability,loopRegistry} from "./engine";

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
  effectSchema:baseline,
  simulate:async(scope,input)=>{
    // Existing canonical UI read model has recipe-cost quality + covered item sales.
    const item=(await getMenuControlCenter()).find(x=>x.id===input.productId);
    if(!item)throw new Error("Product unavailable in authorized café");
    const verifiedUnits=await readPriceExperimentBaselineUnits(scope.businessId,item.id);
    const result=simulatePriceExperiment({productId:item.id,productName:item.name,
      currentPriceCents:item.priceCents,increaseCents:input.increaseCents,
      ingredientCostCents:item.pricing?.productCostCents??null,
      units7Days:verifiedUnits});
    if(!result)throw new Error("Price experiment requires actual, covered sales and recipe cost");
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
  report:async(_scope,effect,samples)=>{
    const observed:PriceExperimentDay[]=samples.map(s=>{
      const d=s.observation;
      return {businessDate:s.businessDate,units:Number(d.units),
        netSalesCents:Number(d.netSalesCents),
        coverage:d.coverage==="actual"?"actual":"unavailable",source:s.source};
    });
    const result=evaluatePriceExperiment(effect as PriceExperimentBaseline,observed,7);
    return {status:result.status,result:{...result,baselineUnits7Days:effect.baselineUnits7Days,
      oldPriceCents:effect.oldPriceCents,newPriceCents:effect.newPriceCents,
      productName:effect.productName},recommendation:result.recommendation,source:"order_lines"};
  },
});
export const supervisorLoopRegistry=loopRegistry(priceExperimentCapability);
