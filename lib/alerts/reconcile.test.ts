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
    expect(staleGeneratedAlertIds(rows, new Set(["scheduled-timecard", "corrected-timecard", "old", "older"]))).toEqual(["predicted", "corrected"]);
  });

  it("resolves a missing-bill alert after that category is entered", () => {
    expect(staleGeneratedAlertIds([{ id: "rent", dedupeKey: "2026-10-rent", status: "seen" }], new Set(["2026-10-rent"]))).toEqual(["rent"]);
  });
  it("retains open incidents when evidence is missing or a period ages out", () => {
    const rows = [{ id: "void", dedupeKey: "2026-10", status: "new" as const }, { id: "break", dedupeKey: "missing-timecard", status: "seen" as const }];
    expect(staleGeneratedAlertIds(rows, new Set())).toEqual([]);
    expect(staleGeneratedAlertIds(rows, new Set(["2026-11"]))).toEqual([]);
  });
});
