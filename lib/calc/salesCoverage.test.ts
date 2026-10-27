import {describe,it,expect} from "vitest";
import {resolveSalesCoverage} from "./salesCoverage";
import {dateOffset} from "./periods";
const p={from:"2026-10-01",to:"2026-10-26"};
describe("provider-neutral canonical sales coverage",()=>{
 it.each(["toast","square","csv"])("recognizes actual days for %s without provider-only gates",provider=>{
  const dates=Array.from({length:26},(_,i)=>dateOffset(p.from,i));
  const result=resolveSalesCoverage(p,dates,[{provider,last_synced_at:null,backfill_completed_at:null}]);
  expect(result.covered).toBe(true);
  expect(result.coveredDays).toBe(26);
  expect(result.missingDays).toEqual([]);
  expect(result.sources).toContain("daily_rollups");
 });
 it("keeps missing days visible instead of manufacturing zero sales",()=>{
  const observed=Array.from({length:23},(_,i)=>dateOffset(p.from,i));
  const result=resolveSalesCoverage(p,observed);
  expect(result.covered).toBe(false);
  expect(result.coveredDays).toBe(23);
  expect(result.missingDays).toEqual(["2026-10-24","2026-10-25","2026-10-26"]);
 });
 it("retains Square's completed historical coverage without claiming Toast zero-days",()=>{
  const c={provider:"square",backfill_completed_at:"2026-10-01T20:00:00Z",last_synced_at:"2026-10-26T20:00:00Z"};
  expect(resolveSalesCoverage(p,[],[c]).covered).toBe(true);
  expect(resolveSalesCoverage(p,[],[{...c,provider:"toast"}]).covered).toBe(false);
 });
 it("rejects unsupported sync windows",()=>{
  const result=resolveSalesCoverage(p,[],[{provider:"square",backfill_completed_at:null,last_synced_at:"2026-10-26T20:00:00Z"}]);
  expect(result.coveredDays).toBe(0);
 });
});
