import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

describe("match-items completion copy", () => {
  it.each([["en",en],["es",es],["ar",ar]] as const)("keeps owner-visible status and navigation translated for %s", (_locale, messages) => {
    for (const key of ["matchItems", "keepYourWork", "noMatches", "matchDone", "matchSaved", "matchError", "backHome"] as const) {
      expect(messages.Menu[key].trim().length).toBeGreaterThan(0);
    }
    expect(messages.Menu.matchDone).not.toBe(en.Menu.matchSaved);
    expect(messages.Menu.backHome).not.toBe(en.Menu.noMatches);
  });
  it("preserves right-to-left Arabic content", () => {
    expect(ar.Menu.matchDone).toMatch(/[\u0600-\u06ff]/u);
    expect(ar.Menu.backHome).toMatch(/[\u0600-\u06ff]/u);
  });
});
