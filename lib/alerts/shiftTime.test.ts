import { describe, expect, it } from "vitest";
import { formatShiftTime } from "./shiftTime";

describe("formatShiftTime", () => {
  it("formats a stored UTC instant in the café timezone rather than the server timezone", () => {
    expect(formatShiftTime("2026-07-10T13:00:00.000Z", "America/Los_Angeles", "en-US")).toBe("06:00");
  });
});
