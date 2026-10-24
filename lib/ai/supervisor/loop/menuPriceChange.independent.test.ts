import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const s=vi.hoisted(()=>({
 business:"11111111-1111-4111-8111-111111111111",
 coffee:"22222222-2222-4222-8222-222222222222",
 latte:"33333333-3333-4333-8333-333333333333",
 prices:{coffee:450,latte:600},
 saves:0,
}));
vi.mock("next/cache",()=>({revalidatePath:vi.fn()}));
vi.mock("@/lib/metrics/p1Readers.server",()=>({
 authorizedOwnerP1:async()=>({identity:{businessId:s.business,currency:"USD"}}),
}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({
 getMenuControlCenter:async()=>[
  {id:s.coffee,name:"Coffee",active:true,priceCents:s.prices.coffee},
  {id:s.latte,name:"Latte",active:true,priceCents:s.prices.latte},
 ],
}));
vi.mock("@/lib/supabase/server",()=>({createServerSupabaseClient:async()=>({})}));
vi.mock("@/lib/data/proposalPrices.server",()=>({
 ownerMenuPrice:async(_scope:unknown,id:string)=>{
  if(id===s.coffee)return s.prices.coffee;
  if(id===s.latte)return s.prices.latte;
  return null;
 },
}));
vi.mock("@/lib/menu/priceHistory",()=>({
 setCanonicalMenuPrice:async(_db:unknown,args:{menuItemId:string;expectedOldPriceCents:number;priceCents:number})=>{
  const key=args.menuItemId===s.coffee?"coffee":args.menuItemId===s.latte?"latte":null;
  if(!key||s.prices[key]!==args.expectedOldPriceCents)return false;
  s.prices[key]=args.priceCents;s.saves++;
  return true;
 },
}));
vi.mock("./sales.server",()=>({readPriceExperimentSalesDays:async()=>[]}));
import {menuPriceChangeCapability,StaleProposalError} from "./menuPriceChange.server";
const scope={businessId:s.business,ownerUserId:"44444444-4444-4444-8444-444444444444",
 threadId:"55555555-5555-4555-8555-555555555555",locale:"en" as const};
beforeEach(()=>{s.prices.coffee=450;s.prices.latte=600;s.saves=0;});
describe("two independent owner price cards",()=>{
 it("both commit when different items were drafted against their own prices",async()=>{
  const coffee=await menuPriceChangeCapability.simulate(scope,{productId:s.coffee,newPriceCents:500});
  const latte=await menuPriceChangeCapability.simulate(scope,{productId:s.latte,newPriceCents:675});
  expect(coffee.effect.preview).toHaveLength(1);
  await Promise.all([menuPriceChangeCapability.commit(scope,coffee.effect),
    menuPriceChangeCapability.commit(scope,latte.effect)]);
  expect(s.prices).toEqual({coffee:500,latte:675});
  expect(s.saves).toBe(2);
 });
 it("does not permit an outdated second card for the same product",async()=>{
  const first=await menuPriceChangeCapability.simulate(scope,{productId:s.coffee,newPriceCents:500});
  const second=await menuPriceChangeCapability.simulate(scope,{productId:s.coffee,newPriceCents:525});
  await menuPriceChangeCapability.commit(scope,first.effect);
  await expect(menuPriceChangeCapability.commit(scope,second.effect))
   .rejects.toBeInstanceOf(StaleProposalError);
  expect(s.prices.coffee).toBe(500);
  expect(s.saves).toBe(1);
 });
});
