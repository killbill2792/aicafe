import {describe,expect,it} from "vitest";
import {retainActionablePrioritySource,settleInboxTasks} from "./inboxLifecycle";
import type {OperatingTask} from "./tasks";
const make=(kind:string,sourceType:string,status:OperatingTask["status"]="needs_owner"):OperatingTask=>({
 id:"priority:"+sourceType,businessId:"11111111-1111-4111-8111-111111111111",
 agentId:sourceType==="supplier_po"?"maya":"leo",
 kind:kind as OperatingTask["kind"],status,
 payload:{sourceType,title:"Supplier purchase-order draft needs your approval",
  threadId:"33333333-3333-4333-8333-333333333333"},
 confidence:"high",evidence:[],createdAt:"2026-11-13T06:00:00.000Z"
});
describe("Task14B one-inbox proactive purchasing source",()=>{
 it("surfaces verified supplier draft notices but never duplicates generic priority receipts",()=>{
  expect(retainActionablePrioritySource(make("priority_notice","supplier_po"))).toBe(true);
  expect(retainActionablePrioritySource(make("priority_notice","alert"))).toBe(false);
  expect(retainActionablePrioritySource(make("priority_notice","operating_task"))).toBe(false);
  expect(retainActionablePrioritySource(make("supply_check",""))).toBe(true);
 });
 it("preserves actionable and handled supplier PO notices in the canonical inbox",()=>{
  const pending=make("priority_notice","supplier_po");
  const result=settleInboxTasks([pending],[],new Date("2026-11-14T00:00:00.000Z"),"2026-11-14");
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({id:pending.id,status:"needs_owner",agentId:"maya"});
  const handled=make("priority_notice","supplier_po","handled");
  const history=settleInboxTasks([handled],[],new Date("2026-11-14T00:00:00.000Z"),"2026-11-14");
  expect(history).toHaveLength(1);
  expect(history[0].status).toBe("handled");
 });
});
