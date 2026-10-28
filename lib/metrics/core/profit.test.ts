import {describe,expect,it} from "vitest";
import {profitForPeriod} from "./profit";
const known=(amountCents:number)=>({amountCents});
describe("partial profit",()=>{
  it("returns a partial subtotal with notes when today's import is missing",()=>{
    const out=profitForPeriod([{date:"2026-10-01",netSalesCents:240000},
      {date:"2026-10-02",netSalesCents:0,salesDataStatus:"missing"}],
    known(32000),{amountCents:null},known(77952),known(65000));
    expect(out.profitCents).toBe(65048);
    expect(out.basis).toBe("partial");
    expect(out.notes).toContain("profitSalesDaysMissing");
    expect(out.notes).toContain("profitFeesMissing");
  });
  it("uses the exact demo day cents, including known processing fees",()=>{
    expect(profitForPeriod([{date:"2026-09-01",netSalesCents:240000}],
      known(32000),known(7000),known(77952),known(65000)).profitCents).toBe(58048);
  });
  it("returns null only when zero sales days are covered",()=>{
    expect(profitForPeriod([{date:"2026-10-01",netSalesCents:0,salesDataStatus:"missing"}],
      known(0),known(0),known(0),known(0)).profitCents).toBeNull();
  });
});
