import {describe,it,expect,vi} from "vitest";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {staffTools} from "./staff";
import type {AgentToolContext} from "./index";

describe("visible Toast owner reviews",()=>{
 it("Staff page shows review cards and the backend provides working owner actions",()=>{
  const page=readFileSync(join(process.cwd(),"app/[locale]/staff/page.tsx"),"utf8");
  const panel=readFileSync(join(process.cwd(),"components/staff/PosImportReviewPanel.tsx"),"utf8");
  const action=readFileSync(join(process.cwd(),"lib/actions/posImportReviews.ts"),"utf8");
  expect(page).toContain("<PosImportReviewPanel");
  expect(panel).toContain("resolvePosStaffImportReview");
  for(const review of ["staff_identity","unlinked_timecard",
    "overlapping_timecard","shift_corrected"])expect(panel).toContain(review);
  expect(action).toContain('rpc("pos_resolve_staff_import_review"');
  expect(action).toContain("requireSchedulingOwner()");
 });
 it("labor chat includes pending staff conflicts with a Staff resolution link",async()=>{
  const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
  const review={reviewType:"staff_identity",sourceKey:"toast:rg:e1",
    detail:{displayName:"Maria",candidates:["employee-1"]}};
  const ctx={asOf:"2026-10-26",locale:"en",timezone:"America/Los_Angeles",
   tools:{
    getLaborMetrics:vi.fn(async()=>({available:true,value:[],quality})),
    getStaffAttendance:vi.fn(async()=>({available:false,value:null,quality:{
     ...quality,level:"low" as const,missingInputs:["noAttendance"]}})),
    getPosImportReviews:vi.fn(async()=>({available:true,value:[review],quality})),
   }} as unknown as AgentToolContext;
  const result=await staffTools.get_labor.execute({period:"today"},ctx);
  expect(result.pendingPosStaffReviews).toEqual([review]);
  expect(result.posReviewHref).toBe("/staff");
 });
});
