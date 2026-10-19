import { describe, expect, it } from "vitest";
import { AUTH_PATHS, isAuthPath } from "./authRoutes";

describe("authentication page navigation boundaries", () => {
  it.each(AUTH_PATHS)("hides app navigation on %s", (path) => {
    expect(isAuthPath(path)).toBe(true);
  });

  it.each(["/", "/more", "/more/cafe-profile", "/onboarding", "/money", "/menu", "/staff", "/operations"])(
    "preserves navigation on %s", (path) => {
      expect(isAuthPath(path)).toBe(false);
    },
  );

  it("does not hide navigation on lookalike paths", () => {
    expect(isAuthPath("/login-extra")).toBe(false);
    expect(isAuthPath("/signup/other")).toBe(false);
  });
});
