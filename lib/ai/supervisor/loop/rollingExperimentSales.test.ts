import {describe,expect,it,vi} from "vitest";
import {comparePriceExposure} from "@/lib/calc/priceExperiment";
vi.mock("server-only",()=>({}));
import {planElapsed24HourWindows,summarizeElapsedWindow,
 planVerifiedFinalCloseInterval,withUnattributedSourceLines} from "./rollingExperimentSales.server";
const item=(overrides:Record<string,unknown>={})=>({
 id:"a",orderedAt:"2026-03-08T01:00:00Z",closedAt:"2026-03-08T01:20:00Z",
 quantity:1,netSalesCents:650,voided:false,toastExcluded:false,
 supersededBy:null,...overrides});
describe("Task 8a actual source-timed 24-hour periods",()=>{
 it("measures exact elapsed hours regardless of US spring DST",()=>{
  const list=planElapsed24HourWindows("2026-03-08T00:00:00Z",3);
  expect(list.map(x=>x.startAt)).toEqual([
   "2026-03-08T00:00:00.000Z","2026-03-09T00:00:00.000Z",
   "2026-03-10T00:00:00.000Z"]);
  for(const w of list)expect(Date.parse(w.endAt)-Date.parse(w.startAt)).toBe(86400000);
 });
 it("accepts database timestamps with explicit numeric UTC offsets",()=>{
  expect(planElapsed24HourWindows("2026-11-11T18:01:00+00:00",1)[0].startAt)
   .toBe("2026-11-11T18:01:00.000Z");
  expect(planElapsed24HourWindows("2026-11-11T18:01:00-08:00",1)[0].startAt)
   .toBe("2026-11-12T02:01:00.000Z");
  expect(()=>planElapsed24HourWindows("2026-11-11T18:01:00",1))
   .toThrow("invalid_source_instant");
 });
 it("measures fall DST in elapsed hours, not 25-hour café days",()=>{
  const list=planElapsed24HourWindows("2026-11-01T08:00:00Z",2);
  expect(list[1].startAt).toBe("2026-11-02T08:00:00.000Z");
 });
 it("keeps start inclusive/end exclusive and excludes voided and superseded",()=>{
  const w=planElapsed24HourWindows("2026-03-08T00:00:00Z",1)[0];
  const lines=[item(),item({id:"b",orderedAt:w.endAt,closedAt:w.endAt}),
    item({id:"c",voided:true}),item({id:"d",supersededBy:"old"})];
  expect(summarizeElapsedWindow(w,lines,true,w.endAt)).toMatchObject({
   status:"actual",units:1,revenueCents:650,countedLines:1});
 });
 it("does not invent sales from lines lacking actual order or close time",()=>{
  const w=planElapsed24HourWindows("2026-03-08T00:00:00Z",1)[0];
  expect(summarizeElapsedWindow(w,[item({orderedAt:null})],true,w.endAt))
   .toMatchObject({status:"insufficient_evidence",units:null,unknownTimeLines:1});
  expect(summarizeElapsedWindow(w,[item({closedAt:null})],true,w.endAt).status)
   .toBe("insufficient_evidence");
 });
 it("rejects source line closures after the observation cutoff",()=>{
  const w=planElapsed24HourWindows("2026-03-08T00:00:00Z",1)[0];
  const observed="2026-03-09T00:00:00Z";
  expect(summarizeElapsedWindow(w,[item({closedAt:"2026-03-10T01:00:00Z"})],
   true,observed)).toMatchObject({status:"insufficient_evidence",units:null,
    unknownTimeLines:1});
 });
 it("does not certify any elapsed interval when source line timestamps are both missing",()=>{
  const w=planElapsed24HourWindows("2026-03-08T00:00:00Z",1)[0];
  const measured=summarizeElapsedWindow(w,[item()],true,w.endAt);
  expect(measured.status).toBe("actual");
  expect(withUnattributedSourceLines(measured,1,true)).toMatchObject({
   status:"insufficient_evidence",units:null,revenueCents:null,
   unknownTimeLines:1});
  expect(withUnattributedSourceLines(measured,0,false)).toMatchObject({
   status:"insufficient_evidence",units:null,revenueCents:null,
   unknownTimeLines:1});
 });
 it("requires real importer coverage and a fully elapsed window",()=>{
  const w=planElapsed24HourWindows("2026-03-08T00:00:00Z",1)[0];
  expect(summarizeElapsedWindow(w,[item()],false,w.endAt).status)
   .toBe("insufficient_evidence");
  expect(summarizeElapsedWindow(w,[item()],true,w.startAt).status)
   .toBe("insufficient_evidence");
 });
 it("reports post-window extra trading only with actual verified close",()=>{
  const w=planElapsed24HourWindows("2026-03-08T00:00:00Z",1)[0];
  expect(planVerifiedFinalCloseInterval(w,null)).toBeNull();
  expect(planVerifiedFinalCloseInterval(w,"2026-03-09T02:00:00Z")).toEqual({
   startAt:w.endAt,endAt:"2026-03-09T02:00:00.000Z"});
  expect(planVerifiedFinalCloseInterval(w,w.endAt)).toBeNull();
 });
 it("reports only the measured exposure before a verified later price change",()=>{
  const window=planElapsed24HourWindows("2026-03-08T00:00:00Z",1)[0];
  const cut="2026-03-08T12:00:00Z";
  expect(summarizeElapsedWindow(window,[item(),
   item({id:"later",orderedAt:cut,closedAt:"2026-03-08T12:30:00Z"})],true,
   "2026-03-09T00:00:00Z",cut)).toMatchObject({window,segmentEndAt:new Date(cut).toISOString(),status:"actual",units:1,revenueCents:650});
  expect(()=>summarizeElapsedWindow(window,[],true,window.endAt,window.startAt)).toThrow();
 });

});

describe("shared price exposure economics",()=>{
 it("detects falling contribution despite a higher selling price without inventing causality",()=>{
  expect(comparePriceExposure({units:80,revenueCents:44000,baselineUnits:100,baselineRevenueCents:50000,unitCostEstimateCents:200})).toMatchObject({
   volumeChangeBps:-2000,revenueChangeBps:-1200,contributionEstimateCents:28000,
   baselineContributionEstimateCents:30000,contributionChangeEstimateCents:-2000,
   contributionMarginEstimateBps:6364,recommendation:"review_revert",nonCausal:true,
   costBasis:"current_cost_estimate"});
 });
 it("preserves actual observed sales independently of absent cost or comparison",()=>{
  expect(comparePriceExposure({units:80,revenueCents:44000,baselineUnits:null,baselineRevenueCents:null,unitCostEstimateCents:null}))
   .toMatchObject({observedRevenueCents:44000,contributionEstimateCents:null,volumeChangeBps:null,recommendation:"adjust",costBasis:"missing"});
 });
 it("does not turn unknown denominators into zero percent, and preserves negative revenue",()=>{
  expect(comparePriceExposure({units:0,revenueCents:-500,baselineUnits:0,baselineRevenueCents:0,unitCostEstimateCents:null}))
   .toMatchObject({observedRevenueCents:-500,contributionEstimateCents:-500,contributionMarginEstimateBps:null,volumeChangeBps:null,recommendation:"adjust"});
 });
});
