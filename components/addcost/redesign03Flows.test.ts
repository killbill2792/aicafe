import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = (file: string) => readFileSync(file, "utf8");

describe("Redesign 03 screen contracts", () => {
  it("remounts a category-linked bill and focuses its amount field", () => {
    const page = source("app/[locale]/more/bills/page.tsx");
    const form = source("components/bills/BillsManager.tsx");
    expect(page).toContain('key={category ?? "none"}');
    expect(form).toContain('openKey] = useState<string | null>(initialOpenKey)');
    expect(form).toContain('initialCategory === OTHER_CATEGORY ? firstOtherBill?.id ?? NEW_OTHER_KEY');
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

  it("closes the recovery form without inventing a transaction", () => {
    const statement = source("components/addcost/StatementUploader.tsx");
    expect(statement).toContain('setMissingLine(false); setMissingDescription(""); setMissingAmount(""); setMissingDate("");');
    expect(statement).toContain('{labels.missingCancel}');
    expect(statement).toContain('disabled={isSavingOrSaved || missingLine || saveLock.current}');
  });

  it("locks every editable statement action while saving, even before React re-renders", () => {
    const statement = source("components/addcost/StatementUploader.tsx");
    expect(statement).toContain('const saveLock = useRef(false)');
    expect(statement).toContain('saveLock.current = true;');
    expect(statement).toContain('if (!state?.ok || missingLine || isSavingOrSaved || saveLock.current) return;');
    expect(statement).toContain('if (!state?.ok || saveLock.current || isSavingOrSaved) return;');
    expect(statement).toContain('if (!state?.ok || !state.balanceCheck || saveLock.current || isSavingOrSaved) return;');
    expect(statement).toContain('disabled={isSavingOrSaved || saveLock.current}');
  });

  it("keeps recovery fields at the minimum 48px touch and 17px text sizes", () => {
    const statement = source("components/addcost/StatementUploader.tsx");
    expect(statement).not.toContain('className="h-11 rounded-xl border border-line px-3"');
    expect(statement).toContain('min-h-12 rounded-xl border border-line px-3 text-[17px]');
    expect(statement).toContain('min-h-12 rounded-full bg-accent px-4 text-[17px]');
  });

  it("does not apply stale overlapping bank uploads and permits a retry", () => {
    const statement = source("components/addcost/StatementUploader.tsx");
    expect(statement).toContain('if (saveLock.current || isSavingOrSaved || readLock.current) return;');
    expect(statement).toContain('readLock.current = true;');
    expect(statement).toContain('readLock.current = false;');
    expect(statement).toContain('onClick={() => setState(null)}');
    expect(statement).toContain('{labels.tryAgain}');
  });

  it("shows a preselected ingredients category that would otherwise be hidden", () => {
    expect(source("components/addcost/TypeExpenseForm.tsx")).toContain('c !== "ingredients" || initialCategory === "ingredients"');
  });

  it("prevents duplicate manual costs during async submission", () => {
    const typed = source("components/addcost/TypeExpenseForm.tsx");
    expect(typed).toContain('const submitLock = useRef(false)');
    expect(typed).toContain('submitLock.current = true');
    expect(typed).toContain('submitLock.current = false');
    expect(typed).toContain('if (amountCents === 0 || !category || submitLock.current || status === "saved") return;');
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
