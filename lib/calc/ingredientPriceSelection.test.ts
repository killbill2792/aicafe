import { describe, expect, it } from "vitest";
import { latestEffectiveIngredientPrice } from "./ingredientPriceSelection";

const ingredient="milk";
const make=(id:string, day:string, recorded_at?:string, cost=100000)=>({
  id,ingredient_id:ingredient,effective_from:day,recorded_at,
  cost_per_base_unit_micros:cost,
});
describe("atomic as-of ingredient price",()=>{
  it("uses latest recorded pack correction on the same business day",()=>{
    const a=make("aaa","2026-10-22","2026-10-22T15:00:00+00:00",100);
    const b=make("bbb","2026-10-22","2026-10-22T16:00:00+00:00",120);
    const r=latestEffectiveIngredientPrice([b,a],"milk","2026-10-22");
    expect(r).toEqual({status:"ready",price:b});
  });
  it("uses the last effective date not a future price",()=>{
    const a=make("aaa","2026-10-20","2026-10-20T15:00:00+00:00");
    const b=make("bbb","2026-10-24","2026-10-24T15:00:00+00:00");
    expect(latestEffectiveIngredientPrice([a,b],"milk","2026-10-22")).toEqual({status:"ready",price:a});
  });
  it("fails closed when legacy same-day rows lack timestamp rather than trusting a random UUID",()=>{
    const a=make("aaa","2026-10-22");
    const b=make("bbb","2026-10-22");
    expect(latestEffectiveIngredientPrice([a,b],"milk","2026-10-22")).toEqual({status:"ambiguous"});
  });
  it("chooses a deterministic ID only when timestamps genuinely match",()=>{
    const a=make("aaa","2026-10-22","2026-10-22T15:00:00Z");
    const b=make("bbb","2026-10-22","2026-10-22T15:00:00Z");
    expect(latestEffectiveIngredientPrice([a,b],"milk","2026-10-22")).toEqual({status:"ready",price:b});
  });
  it("rejects invalid or missing ingredient prices",()=>{
    expect(latestEffectiveIngredientPrice([],"milk","2026-10-22")).toEqual({status:"missing"});
    expect(latestEffectiveIngredientPrice([make("aaa","2026-10-22",undefined,-4)],"milk","2026-10-22")).toEqual({status:"invalid"});
  });
});
