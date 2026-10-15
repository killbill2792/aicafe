import { describe, expect, it } from "vitest";
import { findEquivalentCoverage } from "./coverageIdentity";

const requirement = {
  id: "record-one", revision: 3, location_id: "location-1",
  day_of_week: 3, local_date: null, effective_from: "2026-11-01",
  effective_to: null, start_local: "08:00", end_local: "12:00",
  overnight: false, min_headcount: 1, qualification_code: null,
  min_overlap_minutes: 0, priority: "required",
  source: "owner_direct", confirmation: "owner_confirmed",
};

describe("Coverage create conflict reapplication", () => {
  it("finds co-owner's equivalent requirement despite distinct provenance", () => {
    expect(findEquivalentCoverage([requirement], {
      ...requirement, id: undefined, revision: undefined,
      source: "worker_reported_by_owner", confirmation: "unconfirmed",
    })).toBe(requirement);
  });

  it("never silently converts distinct coverage demand into an edit", () => {
    for (const different of [
      { location_id: "location-2" }, { day_of_week: 4 },
      { local_date: "2026-11-04", day_of_week: null, effective_from: null },
      { start_local: "09:00" }, { end_local: "13:00" },
      { min_headcount: 2 }, { qualification_code: "barista" },
      { effective_to: "2026-12-01" }, { min_overlap_minutes: 30 },
      { priority: "advisory" },
    ]) {
      expect(findEquivalentCoverage([requirement], { ...requirement, ...different })).toBeUndefined();
    }
  });
  it("treats missing optional fields and null as equivalent", () => {
    const noOptional = { ...requirement };
    delete (noOptional as Partial<typeof requirement>).effective_to;
    expect(findEquivalentCoverage([requirement], noOptional)).toBe(requirement);
  });
});
