import {describe,it,expect} from "vitest";
import {z} from "zod";
import {schemas,resolverCoverage,resolverExemptions,type AgentToolName} from "./index";
/** The allowlist fails whenever a new tool accepts target identities without
 * declaring shared resolution or a deliberate new-value exemption. */
describe("entity and period resolver registry",()=>{
 it("accounts for every top-level identity/period input on strict tools",()=>{
  const target=new Set(["query","name","category","product_id","employee_id","period"]);
  for(const name of Object.keys(schemas) as AgentToolName[]){
   const entry=schemas[name];
   const schema=("schema" in entry?entry.schema:entry) as z.ZodType;
   const properties=z.toJSONSchema(schema,{target:"draft-07"}).properties??{};
   for(const key of Object.keys(properties).filter(key=>target.has(key))){
    expect([...(resolverCoverage[name]??[]),...(resolverExemptions[name]??[])]).toContain(key);
   }
  }
 });
 it("declares existing product and nested employee identifiers explicitly",()=>{
  expect(resolverCoverage.get_product_costs).toContain("itemId");
  expect(resolverCoverage.get_price_recommendation).toContain("itemId");
  expect(resolverCoverage.propose_schedule).toContain("shifts.employee_id");
  expect(resolverCoverage.propose_shift_change).toContain("shift.employee_id");
  expect(resolverCoverage.propose_staff_change).toContain("employee_id");
 });
 it("does not confuse new staff and new-item values with existing-record selection",()=>{
  expect(resolverExemptions.propose_add_staff).toContain("name");
  expect(resolverExemptions.suggest_new_item_price).toContain("category");
 });
});
