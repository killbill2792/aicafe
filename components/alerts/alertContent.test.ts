import {describe,expect,it} from "vitest";
import {describeAlert} from "./alertContent";
import type {AlertRow} from "@/lib/data/getAlerts";

const t=((key:string)=>key) as unknown as Parameters<typeof describeAlert>[1];
const alert=(payload:Record<string,unknown>):AlertRow=>({
 id:"alert-1",kind:"meal_break",impactCents:null,payload,status:"new",createdAt:"2026-10-23T12:00:00Z"
});

describe("meal break alert fixes",()=>{
 it("opens the precise employee and date in Staff Schedule, never the legacy Team view",()=>{
  const detail=describeAlert(alert({employeeId:"staff & 1",date:"2026-10-29",employeeName:"Alex"}),t,()=>"-");
  expect(detail.actionHref).toBe("/staff?tab=schedule&date=2026-10-29&employee=staff+%26+1");
 });
 it("does not leak malformed dates into a fix link",()=>{
  const detail=describeAlert(alert({employeeId:"staff",date:"2026-02-30"}),t,()=>"-");
  expect(detail.actionHref).toBe("/staff?tab=schedule&employee=staff");
 });
});
