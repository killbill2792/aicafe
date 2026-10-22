import {expect,it} from "vitest";
import {pantryUnitCostCents} from "./pantryDisplay";
it("renders price per ounce in the correct physical dimension",()=>{
 expect(pantryUnitCostCents(1000,"ml")?.costCents).toBeCloseTo(0.02957352956);
 expect(pantryUnitCostCents(1000,"g")?.costCents).toBeCloseTo(0.028349523125);
 expect(pantryUnitCostCents(1000,"each")).toEqual({costCents:.001,unit:"each"});
 expect(pantryUnitCostCents(null,"ml")).toBeNull();
});