import {beforeEach,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:vi.fn()}));
const authState=vi.hoisted(()=>({businessId:"a0000000-0000-4000-8000-000000000999"}));
vi.mock("@/lib/data/getActiveBusinessId",()=>({getActiveBusinessId:async()=>authState.businessId}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({
 auth:{getUser:async()=>({data:{user:{id:"owner"}}})},
 from:(table:string)=>{
  const filters={eq:()=>filters,maybeSingle:async()=>({data:table==="memberships"?{role:"owner"}:{currency:"USD",is_demo:false}})};
  return {select:()=>filters};
 },
})}));
vi.mock("./sales.server",()=>({readPriceExperimentBaselineUnits:vi.fn(async()=>70),readPriceExperimentSalesDays:vi.fn(async()=>[])}));
import {getMenuControlCenter} from "@/lib/data/getMenuControlCenter";

import {priceExperimentCapability} from "./priceExperiment.server";
const businessId="a0000000-0000-4000-8000-000000000999",productId="a0000000-0000-4000-8000-000000000001";
const scope={businessId,ownerUserId:"owner",threadId:"thread",locale:"en" as const};
const item={id:productId,name:"Latte",priceCents:500,pricing:{productCostCents:125},active:true};
const menu=vi.mocked(getMenuControlCenter);
beforeEach(()=>{vi.clearAllMocks();authState.businessId=businessId;menu.mockResolvedValue([item] as never);});
it("allows an active authenticated product",async()=>{expect((await priceExperimentCapability.simulate(scope,{productId,increaseCents:10})).effect).toMatchObject({newPriceCents:510});});
it("rejects inactive or ambiguous catalog matches",async()=>{menu.mockResolvedValueOnce([{...item,active:false}] as never);await expect(priceExperimentCapability.simulate(scope,{productId,increaseCents:10})).rejects.toThrow("could not be found");menu.mockResolvedValueOnce([item,item] as never);await expect(priceExperimentCapability.simulate(scope,{productId,increaseCents:10})).rejects.toThrow("could not be found");});
it("rejects wrong business before menu lookup",async()=>{authState.businessId="different";await expect(priceExperimentCapability.simulate(scope,{productId,increaseCents:10})).rejects.toThrow("does not match");expect(menu).not.toHaveBeenCalled();});
