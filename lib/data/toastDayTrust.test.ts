import {describe,it,expect,vi,afterEach,beforeEach} from "vitest";
vi.mock("server-only",()=>({}));
const flags=vi.hoisted(()=>vi.fn());
const canonical=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/pos/toast/reportingCoverage",()=>({
 toastDayFlags:flags,unverifiedToastSalesDates:canonical
}));
import {readToastDayTrust,needsLookKey,incompleteDayKey} from "./toastDayTrust.server";
beforeEach(()=>canonical.mockResolvedValue(new Set()));
afterEach(()=>{vi.unstubAllEnvs();flags.mockReset();canonical.mockReset();});
describe("shared Toast day trust",()=>{
 it("disabled Toast auto-sync retains failed-date stored sales with caveat",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","false");
  flags.mockResolvedValue([{date:"2026-08-02",status:"failed",needsLook:false}]);
  canonical.mockResolvedValue(new Set(["2026-08-02"]));
  const result=await readToastDayTrust({} as never,"business","2026-08-02","2026-08-02");
  expect(result.blocked.size).toBe(0);
  expect(result.quality).toContain(incompleteDayKey(["2026-08-02"]));
 });
 it("status read fails keeps stored days + one note",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  flags.mockRejectedValue(new Error("status database unavailable"));
  const result=await readToastDayTrust({} as never,"business","2026-08-01","2026-08-10");
  expect(result.blocked.size).toBe(0);
  expect(result.quality).toEqual(["toastDayStatusUnavailable"]);
 });
 it("66 needs-look days collapse to one note",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  const dates=Array.from({length:66},(_,i)=>new Date(Date.UTC(2026,7,1+i)).toISOString().slice(0,10));
  flags.mockResolvedValue(dates.map(date=>({date,status:"imported",needsLook:true})));
  const result=await readToastDayTrust({} as never,"business",dates[0],dates.at(-1)!);
  expect(result.blocked.size).toBe(0);
  expect(result.quality).toEqual([]);
  expect(result.notes).toEqual([needsLookKey(dates)]);
  expect(result.notes[0]).toContain("66:");
  expect(result.notes[0]).toContain(":63");
  expect(result.notes[0]).toContain(dates[2]);
 });
 it("keeps imported partial days when another Toast location failed",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  flags.mockResolvedValue([
    {date:"2026-08-01",status:"imported",needsLook:false},
    {date:"2026-08-01",status:"failed",needsLook:true},
  ]);
  canonical.mockResolvedValue(new Set(["2026-08-01"]));
  const trust=await readToastDayTrust({} as never,"business","2026-08-01","2026-08-01");
  expect(trust.blocked.size).toBe(0);
  expect(trust.quality).toEqual([incompleteDayKey(["2026-08-01"])]);
  expect(trust.notes).toEqual([needsLookKey(["2026-08-01"])]);
 });
 it("legacy canonical Toast rows without status are visible with one caveat",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  flags.mockResolvedValue([]);
  canonical.mockResolvedValue(new Set(["2026-08-02"]));
  const result=await readToastDayTrust({} as never,"business","2026-08-02","2026-08-02");
  expect(result.blocked.size).toBe(0);
  expect(result.quality).toEqual(["toastDayStatusMissing:2026-08-02"]);
 });
 it("failed Toast staging does not exclude Square or CSV data from the same day",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  flags.mockResolvedValue([{date:"2026-08-02",status:"failed",needsLook:false}]);
  const result=await readToastDayTrust({} as never,"business","2026-08-02","2026-08-02");
  expect(result.blocked.size).toBe(0);
  expect(result.quality).toEqual(["toastFailedNoCanonicalSales:2026-08-02"]);
 });
 it("labels confirmed missing and failed dates without exclusions",async()=>{
  vi.stubEnv("TOAST_AUTO_IMPORT_ENABLED","true");
  flags.mockResolvedValue([
   {date:"2026-08-01",status:"imported",needsLook:false},
   {date:"2026-08-02",status:"failed",needsLook:true},
   {date:"2026-08-03",status:"missing",needsLook:false},
  ]);
  canonical.mockResolvedValue(new Set(["2026-08-02","2026-08-03"]));
  const result=await readToastDayTrust({} as never,"business","2026-08-01","2026-08-03");
  expect(result.blocked.size).toBe(0);
  expect(result.quality).toContain(incompleteDayKey(["2026-08-02","2026-08-03"]));
 });
 it("a failed location is reported even when another location imported the day",async()=>{
  flags.mockResolvedValue([{date:"2026-08-04",status:"imported",needsLook:false},
   {date:"2026-08-04",status:"missing",needsLook:false}]);
  canonical.mockResolvedValue(new Set(["2026-08-04"]));
  const result=await readToastDayTrust({} as never,"b","2026-08-04","2026-08-04");
  expect(result.blocked.size).toBe(0);
  expect(result.quality).toEqual([incompleteDayKey(["2026-08-04"])]);
 });
 it("66 failed days collapse to one note",async()=>{
  const dates=Array.from({length:66},(_,i)=>new Date(Date.UTC(2026,6,i+1)).toISOString().slice(0,10));
  flags.mockResolvedValue(dates.map(date=>({date,status:"failed",needsLook:false})));
  canonical.mockResolvedValue(new Set(dates));
  const result=await readToastDayTrust({} as never,"b",dates[0],dates.at(-1)!);
  expect(result.blocked.size).toBe(0);
  expect(result.quality).toEqual([incompleteDayKey(dates)]);
  expect(result.quality[0]).toContain(":63");
 });
 it("a queued Toast import cannot hide stored sales or be mistaken for complete",async()=>{
  flags.mockResolvedValue([{date:"2026-08-05",status:"queued",needsLook:false}]);
  canonical.mockResolvedValue(new Set(["2026-08-05"]));
  const r=await readToastDayTrust({} as never,"b","2026-08-05","2026-08-05");
  expect(r.blocked.size).toBe(0);
  expect(r.quality).toContain(incompleteDayKey(["2026-08-05"]));
 });

});
