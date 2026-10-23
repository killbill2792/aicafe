import { describe, expect, it } from "vitest";
import { makeMissingStatementLine } from "./statementMissingLine";

const balance = { openingCents: 10_000, closingCents: 7_500, sumCents: -1_000, ok: false };

describe("missing statement line recovery", () => {
  it("adds a unique expense line and reconciles the mismatch in cents", () => {
    const result = makeMissingStatementLine(
      [{ i: 2, date: "2026-10-01", description: "Existing", category: "other", amountCents: 1000, reason: "existing", confidence: 0.8 }],
      balance,
      { description: "  Grocery  ", date: "2026-10-02", amount: "15.00", category: "supplies" },
      "Added manually",
    );
    expect(result?.line).toMatchObject({ i: 3, description: "Grocery", amountCents: 1500, category: "supplies" });
    expect(result?.balance).toMatchObject({ sumCents: -2500, ok: true });
  });
  it("keeps the warning while unreconciled", () => {
    const result = makeMissingStatementLine([], balance, { description: "Fee", date: "2026-10-02", amount: "5", category: "other" }, "Manual");
    expect(result?.balance.ok).toBe(false);
  });
  it.each(["", "-1", "1.234", "abc", "0", "9007199254740999999"])("rejects invalid amounts %s", (amount) => {
    expect(makeMissingStatementLine([], balance, { description: "Fee", date: "2026-10-02", amount, category: "other" }, "Manual")).toBeNull();
  });
  it("rejects impossible dates and blank descriptions", () => {
    expect(makeMissingStatementLine([], balance, { description: "", date: "2026-10-02", amount: "5", category: "other" }, "Manual")).toBeNull();
    expect(makeMissingStatementLine([], balance, { description: "Fee", date: "2026-02-30", amount: "5", category: "other" }, "Manual")).toBeNull();
  });
});
