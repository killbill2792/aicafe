import "server-only";
import {revalidatePath} from "next/cache";
import {z} from "zod";
import {getMenuControlCenter} from "@/lib/data/getMenuControlCenter";
import {authorizedOwnerP1} from "@/lib/metrics/p1Readers.server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {ownerMenuPrice} from "@/lib/data/proposalPrices.server";
import {summarizeActualMenuSales} from "@/lib/calc/menuPriceProposal";
import {setCanonicalMenuPrice} from "@/lib/menu/priceHistory";
import {readPriceExperimentSalesDays} from "./sales.server";
import {registerLoopCapability,type LoopSample} from "./engine";

const cents=z.number().int().safe().positive().max(100000);
const effectSchema=z.strictObject({
  productId:z.uuid(),productName:z.string().min(1).max(200),
  oldPriceCents:z.number().int().safe().nonnegative(),
  newPriceCents:cents,currency:z.literal("USD"),
});
export const menuPriceChangeCapabilityId="alex.menu_price_change.v1";
export class StaleProposalError extends Error{
  constructor(public currentPriceCents:number|null){super("stale_menu_price_proposal");}
}

export const menuPriceChangeCapability=registerLoopCapability({
  id:menuPriceChangeCapabilityId,version:1,
  inputSchema:z.strictObject({productId:z.uuid(),newPriceCents:cents}),
  effectSchema,
  dependencyScope:(effect)=>({version:2,kind:"menu_price",productId:effect.productId}),
  simulate:async(scope,input)=>{
    const owner=await authorizedOwnerP1();
    if(owner.identity.businessId!==scope.businessId||owner.identity.currency!=="USD")
      throw new Error("Price change outside authenticated café scope");
    const matches=(await getMenuControlCenter()).filter(item=>item.active&&item.id===input.productId);
    if(matches.length!==1)throw new Error("Active product unavailable in authorized café");
    const item=matches[0];
    if(item.priceCents===input.newPriceCents)throw new Error("Price is unchanged");
    return {effect:{productId:item.id,productName:item.name,oldPriceCents:item.priceCents,
      newPriceCents:input.newPriceCents,currency:"USD"},
      baseline:{source:"menu_items",status:"actual"},
      monitorSpec:{durationDays:7,metricScope:item.id}};
  },
  commit:async(scope,effect)=>{
    const supabase=await createServerSupabaseClient();
    // The effect has already been atomically claimed by the approval ledger.
    // No model-provided client or service-role write is permitted here.
    const current=await ownerMenuPrice(scope,effect.productId,supabase);
    if(current!==effect.oldPriceCents)throw new StaleProposalError(current);
    const updated=await setCanonicalMenuPrice(supabase,{
      businessId:scope.businessId,menuItemId:effect.productId,
      priceCents:effect.newPriceCents,expectedOldPriceCents:effect.oldPriceCents,
      sourceType:"owner_manual",
      sourceProvider:"Alex (owner approved)",
    });
    if(!updated){
      // The approval may have raced with a Menu edit or POS sync AFTER the
      // optimistic pre-read; the RPC rechecked under the menu row lock.
      const latest=await ownerMenuPrice(scope,effect.productId,supabase);
      if(latest!==effect.oldPriceCents)throw new StaleProposalError(latest);
      throw new Error("Menu price save failed");
    }
    revalidatePath("/menu");revalidatePath("/menu/"+effect.productId);revalidatePath("/");
    return {status:"verified" as const,evidenceSource:"menu_price_history"};
  },
  monitor:async(scope,effect,businessDate)=>{
    const day=(await readPriceExperimentSalesDays(scope.businessId,effect.productId,businessDate,1))[0];
    return day?{businessDate,observation:{...day},source:day.source}:null;
  },
  report:async(_scope,effect,samples:readonly LoopSample[],windowComplete)=>{
    const {coveredDays,observedUnits,observedRevenueCents}=summarizeActualMenuSales(samples);
    const status=coveredDays===7&&windowComplete?"complete":
      windowComplete?"insufficient_evidence":"in_progress";
    return {status,recommendation:"adjust" as const,source:"daily_rollups+order_lines",
      result:{productId:effect.productId,productName:effect.productName,
        oldPriceCents:effect.oldPriceCents,newPriceCents:effect.newPriceCents,
        coveredDays,windowDays:7,observedUnits,
        observedRevenueCents,
        nonCausal:true,note:({en:"Observed sales only; a price change does not prove causation.",
          es:"Solo ventas observadas; un cambio de precio no demuestra causalidad.",
          ar:"هذه مبيعات مرصودة فقط؛ لا يثبت تغيير السعر وجود علاقة سببية."} as const)[_scope.locale]}};
  },
});
