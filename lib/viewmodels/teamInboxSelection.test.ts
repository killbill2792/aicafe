import { describe, expect, it } from "vitest";
import { inboxQueryAfter, readInboxSelection } from "./teamInboxSelection";

describe("team inbox selection in the URL", () => {
  it("reads the teammate and tab, defaulting to the whole team's Needs you", () => {
    expect(readInboxSelection(new URLSearchParams(""))).toEqual({ agent: null, status: "needs_you" });
    expect(readInboxSelection(new URLSearchParams("agent=maya&status=handled"))).toEqual({ agent: "maya", status: "handled" });
    expect(readInboxSelection(new URLSearchParams("agent=bob&status=x"))).toEqual({ agent: null, status: "needs_you" });
  });

  it("switches teammate and keeps the period Home passed", () => {
    expect(inboxQueryAfter("?period=week&agent=alex", { agent: "leo" })).toBe("?period=week&agent=leo");
  });

  it("tapping the selected teammate again shows the whole team", () => {
    expect(inboxQueryAfter("?agent=maya&status=watching", { agent: "maya" })).toBe("?status=watching");
    expect(inboxQueryAfter("?agent=maya", { agent: "maya" })).toBe("");
  });

  it("changes the tab without losing the teammate", () => {
    expect(inboxQueryAfter("?agent=olivia", { status: "handled" })).toBe("?agent=olivia&status=handled");
  });
});
