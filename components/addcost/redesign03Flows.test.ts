import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = (file: string) => readFileSync(file, "utf8");

describe("Redesign 03 screen contracts", () => {
  it("remounts a category-linked bill and focuses its amount field", () => {
    const page = source("app/[locale]/more/bills/page.tsx");
    const form = source("components/bills/BillsManager.tsx");
    expect(page).toContain('key={category ?? "none"}');
    expect(form).toContain('openKey] = useState<string | null>(initialCategory)');
    expect(form).toContain('scrollIntoView');
    expect(form).toContain('amountRef.current?.focus({ preventScroll: true })');
    expect(form).toContain('ref={amountInputRef}');
  });

  it("does not expose unavailable AI entry methods", () => {
    const choices = source("app/[locale]/add-cost/page.tsx");
    expect(choices).toContain('const aiEnabled = isAiConfigured()');
    expect(choices).toContain('...(aiEnabled ? [{ href: "/add-cost/receipt"');
    expect(choices).toContain('...(aiEnabled ? [{ href: "/add-cost/voice"');
    expect(choices).toContain('addCostChoiceSuffix(category, returnTo)');
  });

  it("highlights low-confidence statement rows and exposes a missing-line form on mismatch", () => {
    const statement = source("components/addcost/StatementUploader.tsx");
    expect(statement).toContain('const needsReview = line.confidence < 0.7');
    expect(statement).toContain('role={needsReview ? "group" : undefined}');
    expect(statement).toContain('aria-label={needsReview ? labels.lowConfidence : undefined}');
    expect(statement).toContain('state.balanceCheck && !state.balanceCheck.ok');
    expect(statement).toContain('makeMissingStatementLine(state.lines, state.balanceCheck');
  });

  it("respects safe return navigation in typed and statement entry", () => {
    const typed = source("components/addcost/TypeExpenseForm.tsx");
    const statement = source("components/addcost/StatementUploader.tsx");
    expect(typed).toContain('validReturnTo(returnTo ?? undefined) ?? "/money"');
    expect(statement).toContain('validReturnTo(returnTo ?? undefined) ?? "/money"');
    expect(typed).toContain('router.push(safeReturnTo)');
    expect(statement).toContain('router.push(safeReturnTo)');
  });
});
