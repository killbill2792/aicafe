import { describe, expect, it } from "vitest";
import { isAdminEmail } from "./access";
describe("admin allowlist", () => {
  it("fails closed for absent/mismatched identity and environment", () => {
    expect(isAdminEmail("admin@example.com", undefined)).toBe(false);
    expect(isAdminEmail(undefined, "admin@example.com")).toBe(false);
    expect(isAdminEmail("owner@example.com", "admin@example.com")).toBe(false);
    expect(isAdminEmail("admin@example.com.evil", "admin@example.com")).toBe(false);
  });
  it("matches exact, trimmed, case-insensitive comma-separated addresses", () => {
    expect(isAdminEmail(" Admin@Example.com ", " ops@example.com , ADMIN@example.com ")).toBe(true);
  });
});
