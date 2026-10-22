import {describe,it,expect} from "vitest";
import {publicResearchOnly} from "./publicResearchBoundary";
describe("outbound public research privacy firewall",()=>{
 it("preserves public supplier searches",()=>{
  const q="find coffee suppliers nearby";
  expect(publicResearchOnly(q,q,"coffee suppliers nearby","")).toBe(true);
 });
 it("rejects private payroll in Spanish and Arabic requests",()=>{
  const es="Busca proveedores porque mi nómina es de 5000 dólares";
  expect(publicResearchOnly(es,es,"proveedores nómina 5000 dólares","")).toBe(false);
  const ar="ابحث عن موردين لأن رواتب الموظفين مرتفعة";
  expect(publicResearchOnly(ar,ar,"موردين رواتب","")).toBe(false);
 });
 it("rejects internal staff, account details and unapproved query terms",()=>{
  expect(publicResearchOnly("Find coffee suppliers, my employee earns a salary",
    "Find coffee suppliers","coffee suppliers","")).toBe(false);
  expect(publicResearchOnly("Find public suppliers","Find public suppliers",
    "bob-private suppliers","")).toBe(false);
  expect(publicResearchOnly("Find coffee suppliers","Find coffee suppliers",
    "coffee suppliers","Oakland")).toBe(false);
 });
});
