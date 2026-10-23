import {describe,it,expect} from "vitest";
import {displayKnownCost,displayAverageCost} from "./format";
describe("cost coverage",()=>{
  it("does not present incomplete costs as complete",()=>{
    expect(displayKnownCost(0,0,4)).toBe("Not priced");
    expect(displayKnownCost(0,0,0)).toBe("No turns");
    expect(displayKnownCost(0.5,1,3)).toContain("2 unpriced");
    expect(displayAverageCost(null,0,2)).toBe("Not priced");
    expect(displayAverageCost(0.05,1,2)).toContain("priced only");
  });
});
