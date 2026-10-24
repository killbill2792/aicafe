import { describe,it,expect } from "vitest";
import { modelFamily } from "./modelFamily";
import { standardModelTokenRates } from "@/lib/calc/supervisorTokenCost";
describe("executed model family pricing",()=>{
 it.each(["luna","sol","astra"])("prices gpt-6-%s snapshots",family=>{
  const model="gpt-6-"+family;
  expect(modelFamily(model)).toBe(model);
  expect(standardModelTokenRates(model,"standard",500)).not.toBeNull();
  expect(modelFamily("gpt-6.1-"+family+"-2026-10-01")).toBe(model);
  expect(standardModelTokenRates("gpt-6.1-"+family+"-2026-10-01","default",500)).not.toBeNull();
 });
 it("rejects unknown model rates, never estimates a free call",()=>{
  expect(modelFamily("unrecognized-model")).toBeNull();
  expect(standardModelTokenRates("unrecognized-model",null,500)).toBeNull();
 });
});
