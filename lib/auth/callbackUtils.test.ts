import { describe, expect, it } from "vitest";
import { authDestination, authFlow, authLocale, authTokenType, safeCallbackDestination, tokenDestination } from "./callbackUtils";

describe("auth callback routing", () => {
  it("accepts supported locales and falls back safely", () => {
    expect(authLocale("es")).toBe("es");
    expect(authLocale("ar")).toBe("ar");
    expect(authLocale("fr")).toBe("en");
    expect(authLocale(null)).toBe("en");
  });

  it("chooses the expected signup, login and recovery destinations", () => {
    expect(authFlow("signup")).toBe("signup");
    expect(authFlow("recovery")).toBe("recovery");
    expect(authFlow("invalid")).toBe("magic");
    expect(authDestination("en", "signup")).toBe("/en/onboarding");
    expect(authDestination("es", "recovery")).toBe("/es/reset-password");
    expect(authDestination("ar", "magic")).toBe("/ar");
  });

  it("rejects external and unrelated redirection targets, including locale lookalikes", () => {
    for (const attempted of [
      "//evil.test", "https://evil.test", "/en-evasion", "/es/onboarding",
      "/en/../operations", "/en/%2f%2fevil.test", "/en\\operations",
      "/en/operations", "/en/reset-password?next=https://evil.test",
    ]) {
      expect(safeCallbackDestination("en", attempted, "magic")).toBe("/en");
    }
    expect(safeCallbackDestination("en", "/en/onboarding", "magic")).toBe("/en/onboarding");
    expect(safeCallbackDestination("en", "/en/reset-password", "recovery")).toBe("/en/reset-password");
    expect(safeCallbackDestination("en", null, "signup")).toBe("/en/onboarding");
  });

  it("only accepts known hash verification types and always selects a type-specific path", () => {
    expect(authTokenType("signup")).toBe("signup");
    expect(authTokenType("recovery")).toBe("recovery");
    expect(authTokenType("email")).toBe("email");
    expect(authTokenType("invite")).toBeNull();
    expect(authTokenType(null)).toBeNull();
    expect(tokenDestination("en", "signup")).toBe("/en/onboarding");
    expect(tokenDestination("ar", "recovery")).toBe("/ar/reset-password");
    expect(tokenDestination("es", "email")).toBe("/es");
  });
});
