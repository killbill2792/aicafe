import { describe, expect, it } from "vitest";
import { recurringCostAmountCentsFromInput } from "./recurringCostAmount";

describe("recurring monthly bill amount", () => {
  it("treats blank as not provided", () => {
    expect(recurringCostAmountCentsFromInput("")).toBeNull();
    expect(recurringCostAmountCentsFromInput("   ")).toBeNull();
  });

  it("accepts a confirmed zero-dollar bill", () => {
    expect(recurringCostAmountCentsFromInput("0")).toBe(0);
    expect(recurringCostAmountCentsFromInput("0.00")).toBe(0);
  });

  it("converts positive dollar amounts to cents", () => {
    expect(recurringCostAmountCentsFromInput("123.45")).toBe(12_345);
  });

  it("rejects negative or invalid amounts", () => {
    expect(recurringCostAmountCentsFromInput("-1")).toBeNull();
    expect(recurringCostAmountCentsFromInput("abc")).toBeNull();
  });
});
