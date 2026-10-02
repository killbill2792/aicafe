import { describe, expect, it } from "vitest";
import { staleGeneratedAlertIds } from "./reconcile";

describe("generated alert cleanup", () => {
  it("resolves stale predicted/corrected meal-break alerts while preserving history", () => {
    const rows = [
      { id: "predicted", dedupeKey: "scheduled-timecard", status: "new" as const },
      { id: "corrected", dedupeKey: "corrected-timecard", status: "seen" as const },
      { id: "still-real", dedupeKey: "violating-timecard", status: "new" as const },
      { id: "dismissed", dedupeKey: "old", status: "dismissed" as const },
      { id: "resolved", dedupeKey: "older", status: "resolved" as const },
    ];
    expect(staleGeneratedAlertIds(rows, new Set(["violating-timecard"]))).toEqual(["predicted", "corrected"]);
  });

  it("resolves a missing-bill alert after that category is entered", () => {
    expect(staleGeneratedAlertIds([{ id: "rent", dedupeKey: "2026-10-rent", status: "seen" }], new Set())).toEqual(["rent"]);
  });
});
