import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFixtureSnapshot } from "@/lib/data/fixtureSnapshot";
import { buildStaffViewModel, type StaffRosterMember } from "./staffViewModel";
import type { BusinessSnapshot, StaffShift } from "@/lib/data/types";

const staff: StaffRosterMember[] = [
  { id: "ana", name: "Ana", active: true },
  { id: "removed", name: "Former employee", active: false },
  { id: "dee", name: "Dee", active: true },
];

function shift(employeeId: string, name: string, clockIn: string, clockOut: string | null = null, schedule = false): StaffShift {
  return {
    employeeId, name, role: "Barista",
    timecard: {
      clockIn, clockOut, hourlyWageCents: 2000, breaks: [],
      ...(schedule ? { scheduleId: "s1", sourceType: "owner_schedule" as const } : {}),
    },
  };
}

function snapshot(now: string, shifts: StaffShift[], timezone = "America/Los_Angeles"): BusinessSnapshot {
  return {
    ...getFixtureSnapshot(),
    business: { ...getFixtureSnapshot().business, timezone },
    staffNowIso: now,
    staffShiftsToday: shifts,
  };
}

describe("On shift now: current roster only", () => {
  it("does not discard historic timecards at the snapshot boundary", () => {
    const source = readFileSync(join(process.cwd(), "lib/data/snapshot.server.ts"), "utf8");
    const reader = source.split("async function getStaffShiftsToday(")[1]?.split("async function getMenuItemSnapshots(")[0];
    expect(reader).toContain('from("timecards")');
    expect(reader).toContain("return (data ?? []).map(");
    expect(reader).not.toContain('eq("active",true)');
    expect(reader).not.toContain("activeIds.has(");
  });
  it("excludes removed staff even if their timecard remains open", () => {
    const vm = buildStaffViewModel(snapshot("2026-10-23T18:00:00Z", [
      shift("ana", "Ana", "2026-10-23T17:00:00Z"),
      shift("removed", "Former employee", "2026-10-23T17:00:00Z"),
    ]), staff);
    expect(vm.onShift.map(person => person.name)).toEqual(["Ana"]);
    expect(vm.hasUnmatchedTimecards).toBe(false);
  });

  it("never reassigns archived employee UUIDs to a same-named current staffer", () => {
    const current = {id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",name:"Dawn",active:true};
    const archivedId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
    const vm=buildStaffViewModel(snapshot("2026-10-23T18:00:00Z",[
      shift(archivedId,"Dawn","2026-10-23T17:00:00Z"),
    ]),[current]);
    expect(vm.onShift).toEqual([]);
    expect(vm.hasUnmatchedTimecards).toBe(true);
  });

  it("retains earned labor cost for deactivated and unlinked staff without showing them on shift", () => {
    const archivedShift = shift("removed", "Former employee", "2026-10-23T16:00:00Z", "2026-10-23T17:00:00Z");
    const unknownShift = shift("external-unlinked", "Unlinked", "2026-10-23T16:00:00Z", "2026-10-23T17:00:00Z");
    const asOf = snapshot("2026-10-23T18:00:00Z", [archivedShift, unknownShift]);
    const activeVersion = buildStaffViewModel(asOf, [
      { id: "removed", name: "Former employee", active: true },
    ]);
    const inactiveVersion = buildStaffViewModel(asOf, staff);
    expect(inactiveVersion.costTodayCents).toBeGreaterThan(0);
    expect(inactiveVersion.costTodayCents).toBe(activeVersion.costTodayCents);
    expect(inactiveVersion.onShift).toEqual([]);
    expect(inactiveVersion.hasUnmatchedTimecards).toBe(true);
  });

  it("ignores stale open timecards from the previous cafe-local day", () => {
    const vm = buildStaffViewModel(snapshot("2026-10-23T18:00:00Z", [
      shift("ana", "Ana", "2026-10-23T06:50:00Z"),
    ]), staff);
    expect(vm.onShift).toEqual([]);
  });

  it("ignores ghost names, exposes the review link flag, and matches unique imported names", () => {
    const vm = buildStaffViewModel(snapshot("2026-10-23T18:00:00Z", [
      shift("unlinked", "Jose", "2026-10-23T17:00:00Z"),
      shift("external-dee", "  DEE  ", "2026-10-23T17:00:00Z"),
    ]), staff);
    expect(vm.onShift.map(person => person.name)).toEqual(["Dee"]);
    expect(vm.hasUnmatchedTimecards).toBe(true);
  });

  it("uses cafe-local midnight, not UTC midnight", () => {
    const vm = buildStaffViewModel(snapshot("2026-10-24T06:55:00Z", [
      shift("ana", "Ana", "2026-10-23T22:00:00Z"),
      shift("dee", "Dee", "2026-10-24T06:50:00Z"),
    ]), staff);
    expect(vm.onShift.map(person => person.name)).toEqual(["Ana", "Dee"]);
    const next = buildStaffViewModel(snapshot("2026-10-24T07:05:00Z", [
      shift("ana", "Ana", "2026-10-23T22:00:00Z"),
      shift("dee", "Dee", "2026-10-24T06:50:00Z"),
    ]), staff);
    expect(next.onShift).toEqual([]);
  });

  it("recognizes a scheduled interval, not a completed actual clock-out", () => {
    const vm = buildStaffViewModel(snapshot("2026-10-23T18:00:00Z", [
      shift("ana", "Ana", "2026-10-23T17:00:00Z", "2026-10-23T20:00:00Z", true),
      shift("dee", "Dee", "2026-10-23T17:00:00Z", "2026-10-23T17:30:00Z"),
    ]), staff);
    expect(vm.onShift.map(person => person.name)).toEqual(["Ana"]);
  });

  it("counts each employee once when schedule and actual records overlap", () => {
    const vm = buildStaffViewModel(snapshot("2026-10-23T18:00:00Z", [
      shift("ana", "Ana", "2026-10-23T17:00:00Z", "2026-10-23T21:00:00Z", true),
      shift("ana", "Ana", "2026-10-23T17:30:00Z"),
    ]), staff);
    expect(vm.onShift).toHaveLength(1);
    expect(vm.onShift[0].clockInIso).toBe("2026-10-23T17:30:00Z");
  });
});


describe("staff efficiency excludes partial wages",()=>{
  it("omits known-only missing day, but keeps the same complete day",()=>{
    const base=snapshot("2026-09-09T19:15:00Z",[]);
    const recorded=base.last7Days[0];
    const missing={...recorded,wagesCents:1200,staffTaxCents:144,
      laborWageStatus:"missing" as const};
    const vm=buildStaffViewModel({...base,last7Days:[missing]},staff);
    expect(vm.dailyCostPerSalesDollarCents).toEqual([]);
    const verified=buildStaffViewModel({...base,last7Days:[
      {...missing,laborWageStatus:"actual"}]},staff);
    expect(verified.dailyCostPerSalesDollarCents).toHaveLength(1);
  });
});
