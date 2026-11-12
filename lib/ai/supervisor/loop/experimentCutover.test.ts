import {describe,expect,it} from "vitest";
import {resolveExperimentCutoverMode} from "./experimentCutover.server";

describe("Task 8a experiment single-writer cutover",()=>{
 it("defaults to legacy when release evidence is absent",()=>{
  expect(resolveExperimentCutoverMode({requested:"new",parityProven:false,
   rollbackProven:true,releaseApproved:true})).toBe("legacy");
  expect(resolveExperimentCutoverMode({requested:"new",parityProven:true,
   rollbackProven:false,releaseApproved:true})).toBe("legacy");
  expect(resolveExperimentCutoverMode({requested:"new",parityProven:true,
   rollbackProven:true,releaseApproved:false})).toBe("legacy");
 });
 it("runs shadow only as read-only and permits new only with all gates",()=>{
  expect(resolveExperimentCutoverMode({requested:"shadow",parityProven:false,
   rollbackProven:false,releaseApproved:false})).toBe("shadow");
  expect(resolveExperimentCutoverMode({requested:"new",parityProven:true,
   rollbackProven:true,releaseApproved:true})).toBe("new");
 });
 it("rejects unknown or missing persisted modes",()=>{
  expect(resolveExperimentCutoverMode({requested:"unknown",parityProven:true,
   rollbackProven:true,releaseApproved:true})).toBe("legacy");
  expect(resolveExperimentCutoverMode({requested:null,parityProven:true,
   rollbackProven:true,releaseApproved:true})).toBe("legacy");
 });
});
