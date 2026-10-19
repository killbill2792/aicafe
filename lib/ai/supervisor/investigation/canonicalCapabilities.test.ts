import {describe,it,expect} from "vitest";
import {modelVisibleIds,describeSourceFields,CANONICAL_ALIASES} from "./canonicalCapabilities";
import {readers,values} from "@/lib/metrics/p1Catalog";
import {z} from "zod";
describe("canonical capability grouping",()=>{
  it("preserves all registered values while exposing one tool per equivalent reader",()=>{
    expect(Object.keys(values).length).toBeGreaterThan(25);
    const aliases=Object.keys(CANONICAL_ALIASES);
    const keys=Object.keys(values).map(id=>"p3."+id+".v1");
    const visible=modelVisibleIds(keys);
    expect(visible.length).toBe(keys.length-aliases.length);
    for(const alias of aliases){
      const selected=CANONICAL_ALIASES[alias as keyof typeof CANONICAL_ALIASES];
      expect(visible).not.toContain(alias);
      expect(visible).toContain(selected.parent);
      const source=alias.slice(3,-3) as keyof typeof readers;
      const parent=selected.parent.slice(3,-3) as keyof typeof readers;
      expect(readers[source]).toBe(readers[parent]);
    }
  });
  it("does not hide a scalar without an available structured source",()=>{
    expect(modelVisibleIds(["p3.money.recurring_monthly_bills_cents.v1"])).toEqual(
      ["p3.money.recurring_monthly_bills_cents.v1"]);
  });
  it("describes actual schema fields without copying café data",()=>{
    const schema=z.toJSONSchema(z.strictObject({value:z.strictObject({
      totalCents:z.number().int(),active:z.boolean()})}));
    expect(describeSourceFields(schema)).toContain("totalCents:number (USD cents)");
    expect(describeSourceFields(schema)).toContain("active:boolean");
  });
});
