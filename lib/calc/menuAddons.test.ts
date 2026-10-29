import {expect,it} from "vitest";
import {additiveCostCents,keepFromAddon} from "./menuAddons";
it("uses the actual shared microcent basis for milk replacements",()=>{
 expect(keepFromAddon(75,0)).toBe(75);
});
it("does not fabricate a cost or a keep amount for unknown prices",()=>{
 expect(additiveCostCents(300,null)).toBeNull();
 expect(keepFromAddon(75,null)).toBeNull();
});
it("represents free and negatively profitable extras honestly",()=>{
 expect(keepFromAddon(0,24)).toBe(-24);
 expect(keepFromAddon(50,65)).toBe(-15);
});