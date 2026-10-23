import {describe,expect,it} from "vitest";
import {agentToolDefinitions,agentForTool} from "./index";

const gated=[
 "propose_schedule","propose_shift_change","propose_add_staff",
 "propose_staff_change","propose_availability_change",
 "propose_rule_change","propose_send_schedule"
];
describe("staff approval gate",()=>{
 it("registers staff proposals only through the shared approval engine",()=>{
  const defined=new Set(agentToolDefinitions.map(d=>d.name));
  expect(defined.has("propose_price_change")).toBe(true);
  expect(gated.filter(name=>defined.has(name))).toEqual(gated);
 });
 it("keeps registered scheduling tools read-only",()=>{
  for(const name of ["get_team","get_week_schedule","get_labor_rules","get_coverage_gaps","get_shift_cost"]){
   expect(agentToolDefinitions.some(d=>d.name===name)).toBe(true);
   expect(agentForTool(name)).toBe("olivia");
  }
 });
});
