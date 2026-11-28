import { describe, expect, it } from "vitest";
import { employeeKeys, workforceRoster } from "./roster";

describe("management workforce roster", () => {
  it("provides a manager and four configured specialists without saved profiles", () => {
    const roster = workforceRoster();
    expect(roster.map((profile) => profile.key)).toEqual(employeeKeys);
    expect(roster[0]).toMatchObject({ key: "general_manager", name: "Luna", reportsTo: null });
    for (const profile of roster.slice(1)) {
      expect(profile.reportsTo).toBe("general_manager");
      expect(profile.avatar).toMatch(/^\/ai-team\//);
      expect(profile.responsibilities.length).toBeGreaterThan(0);
    }
  });

  it("applies overrides by stable key and falls back for cleared fields", () => {
    const baseline = workforceRoster();
    const renamed = workforceRoster([
      { employee_key: "general_manager", display_name: "Sam", job_title: null },
      { employee_key: "growth", display_name: null, job_title: "Revenue Lead" },
    ]);
    expect(renamed[0]).toEqual({ ...baseline[0], name: "Sam" });
    expect(renamed[1]).toEqual({ ...baseline[1], title: "Revenue Lead" });
    expect(renamed.slice(2)).toEqual(baseline.slice(2));
    expect(workforceRoster()).toEqual(baseline);
  });
});
