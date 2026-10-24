import { describe, expect, it } from "vitest";
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
  it("excludes removed staff even if their timecard remains open", () => {
    const vm = buildStaffViewModel(snapshot("2026-10-23T18:00:00Z", [
      shift("ana", "Ana", "2026-10-23T17:00:00Z"),
      shift("removed", "Former employee", "2026-10-23T17:00:00Z"),
    ]), staff);
    expect(vm.onShift.map(person => person.name)).toEqual(["Ana"]);
    expect(vm.hasUnmatchedTimecards).toBe(false);
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
