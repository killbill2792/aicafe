import { describe, expect, it } from "vitest";
import { staffHeroState } from "./staffViewModel";

describe("staff hero state", () => {
  it("hides meaningless live rates when nobody is working but preserves today's cost", () => {
    expect(staffHeroState({ onShift: [], costPerHourCents: 0, costPerMinuteCents: 0, costTodayCents: 24613 })).toEqual({ kind: "nobody_working", costTodayCents: 24613 });
  });

  it("shows people, live loaded rates, and today's cost when staff are working", () => {
    const onShift = [{}, {}] as never[];
    expect(staffHeroState({ onShift, costPerHourCents: 6944, costPerMinuteCents: 115.733, costTodayCents: 55560 })).toEqual({ kind: "working", peopleCount: 2, costPerHourCents: 6944, costPerMinuteCents: 115.733, costTodayCents: 55560 });
  });
});
