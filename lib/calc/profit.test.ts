import { describe, expect, it } from "vitest";
import { averageOrderValueCents } from "./profit";

describe("averageOrderValueCents", () => {
  it("rounds a non-whole division half-up to the cent, never leaking fractional cents", () => {
    // 1,000 / 3 = 333.333...¢ — must round to a whole cent, not stay fractional.
    const result = averageOrderValueCents(1_000, 3);
    expect(result).toBe(333);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("rounds a half-cent case up, matching the repository's half-up rule", () => {
    // 1,001 / 2 = 500.5¢ -> 501¢.
    expect(averageOrderValueCents(1_001, 2)).toBe(501);
  });

  it("is 0 when there are no orders, never a division-by-zero NaN/Infinity", () => {
    expect(averageOrderValueCents(5_000, 0)).toBe(0);
  });

  it("divides evenly when sales split evenly across orders", () => {
    expect(averageOrderValueCents(9_000, 3)).toBe(3_000);
  });
});
