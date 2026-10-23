"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { reviewStatementCsv } from "@/lib/actions/statementReview";
import { saveCategorizedLines, type ReviewLine } from "@/lib/actions/expenses";
import { readUploadedFileAsCsvText, UPLOAD_FILE_ACCEPT } from "@/lib/pos/csv/readUploadedFile";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import { validReturnTo } from "@/components/addcost/routeParams";
import { makeMissingStatementLine } from "@/components/addcost/statementMissingLine";

type ReviewableLine = ReviewLine & { correctedCategory?: ExpenseCategoryCode };
type BalanceCheck = { openingCents: number; closingCents: number; sumCents: number; ok: boolean };
type ReviewState =
  | { ok: true; lines: ReviewableLine[]; balanceCheck: BalanceCheck | null; unrecognizedColumns: boolean }
  | { ok: false; error: string };

export default function StatementUploader({
  categoryLabels,
  labels,
  returnTo,
}: {
  returnTo?: string | null;
  categoryLabels: Record<ExpenseCategoryCode, string>;
  labels: {
    uploadPrompt: string;
    chooseFile: string;
    reading: string;
    saveAll: string;
    saved: string;
    balanceOk: string;
    balanceMismatch: string;
    lowConfidence: string;
    exclude: string;
    addMissingLine: string;
    missingLineHint: string;
    missingDescription: string;
    missingAmount: string;
    missingDate: string;
    missingCategory: string;
    missingConfirm: string;
    saveError: string;
  };
}) {
  const router = useRouter();
  const locale = useLocale();
  const safeReturnTo = validReturnTo(returnTo ?? undefined) ?? "/money";
  const formatAmount = (cents: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(cents / 100);
  const [state, setState] = useState<ReviewState | null>(null);
  const [isPending, startTransition] = useTransition();
  const [missingLine, setMissingLine] = useState(false);
  const [missingDescription, setMissingDescription] = useState("");
  const [missingAmount, setMissingAmount] = useState("");
  const [missingDate, setMissingDate] = useState("");
  const [missingCategory, setMissingCategory] = useState<ExpenseCategoryCode>("other");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const missingCandidate = state?.ok && state.balanceCheck ? makeMissingStatementLine(state.lines, state.balanceCheck, {
    description: missingDescription, amount: missingAmount, date: missingDate, category: missingCategory,
  }, labels.addMissingLine) : null;

  function handleFile(file: File) {
    startTransition(async () => {
      const text = await readUploadedFileAsCsvText(file);
      const result = await reviewStatementCsv(text);
      setMissingLine(false);
      setSaveStatus("idle");
      setState(result);
    });
  }

  function updateCategory(i: number, category: ExpenseCategoryCode | "exclude") {
    if (!state?.ok) return;
    setState({ ...state, lines: state.lines.map((l) => (l.i === i ? { ...l, correctedCategory: category === "exclude" ? undefined : category, category: category === "exclude" ? "exclude" : l.category } : l)) });
  }

  function addMissingLine() {
    if (!state?.ok || !state.balanceCheck) return;
    const added = makeMissingStatementLine(state.lines, state.balanceCheck, {
      description: missingDescription,
      amount: missingAmount,
      date: missingDate,
      category: missingCategory,
    }, labels.addMissingLine);
    if (!added) return;
    setState({ ...state, lines: [...state.lines, added.line], balanceCheck: added.balance });
    setMissingLine(false);
    setMissingDescription("");
    setMissingAmount("");
    setMissingDate("");
  }

  function handleSaveAll() {
    if (!state?.ok) return;
    setSaveStatus("saving");
    startTransition(async () => {
      const result = await saveCategorizedLines("statement", state.lines);
      if (result.ok) {
        setSaveStatus("saved");
        setTimeout(() => {
          // next-intl would add a second locale prefix to an already localized return path.
          if (returnTo && /^\/(?:en|es|ar)(?:\/|[?#]|$)/.test(safeReturnTo)) window.location.assign(safeReturnTo);
          else router.push(safeReturnTo);
        }, 900);
      } else {
        setSaveStatus("error");
      }
    });
  }

  if (!state) {
    return (
      <label className="flex flex-col items-center gap-3 rounded-card-lg border-2 border-dashed border-line bg-card p-8 text-center">
        <span className="text-base font-semibold text-ink">{isPending ? labels.reading : labels.uploadPrompt}</span>
        <span className="rounded-full bg-accent px-5 py-2.5 text-sm font-bold text-on-accent">{labels.chooseFile}</span>
        <input
          type="file"
          accept={UPLOAD_FILE_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </label>
    );
  }

  if (!state.ok) {
    return <p className="rounded-card-lg bg-warn-tint p-4 text-warn">{state.error}</p>;
  }

  return (
    <div className="flex flex-col gap-3.5">
      {state.balanceCheck && (
        <div className={`rounded-2xl p-3.5 text-sm font-semibold ${state.balanceCheck.ok ? "bg-good-tint text-good" : "bg-warn-tint text-warn"}`}>
          {state.balanceCheck.ok ? labels.balanceOk : labels.balanceMismatch}
        </div>
      )}
      {state.balanceCheck && !state.balanceCheck.ok && (
        <button type="button" onClick={() => setMissingLine(true)} className="rounded-full border border-warn px-4 py-3 text-sm font-bold text-warn">{labels.addMissingLine}</button>
      )}
      {missingLine && (
        <div className="flex flex-col gap-3 rounded-card-lg border border-warn bg-card p-4">
          <p className="text-sm text-ink-muted">{labels.missingLineHint}</p>
          <label className="flex flex-col gap-1 text-sm font-semibold">{labels.missingDescription}
            <input type="text" value={missingDescription} onChange={(e) => setMissingDescription(e.target.value)} className="h-11 rounded-xl border border-line px-3" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold">{labels.missingAmount}
            <input type="number" min="0.01" step="0.01" value={missingAmount} onChange={(e) => setMissingAmount(e.target.value)} className="h-11 rounded-xl border border-line px-3" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold">{labels.missingDate}
            <input type="date" value={missingDate} onChange={(e) => setMissingDate(e.target.value)} className="h-11 rounded-xl border border-line px-3" />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold">{labels.missingCategory}
            <select value={missingCategory} onChange={(e) => setMissingCategory(e.target.value as ExpenseCategoryCode)} className="h-11 rounded-xl border border-line px-3">
              {EXPENSE_CATEGORY_CODES.map((code) => <option key={code} value={code}>{categoryLabels[code]}</option>)}
            </select>
          </label>
          <button type="button" onClick={addMissingLine} disabled={!missingCandidate} className="h-11 rounded-full bg-accent text-sm font-bold text-on-accent disabled:opacity-40">{labels.missingConfirm}</button>
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-card-lg bg-card p-2">
        {state.lines.map((line) => {
          const category = line.correctedCategory ?? (line.category === "exclude" ? "other" : line.category);
          const needsReview = line.confidence < 0.7;
          const isExcluded = line.category === "exclude" && !line.correctedCategory;
          return (
            <div key={line.i} role={needsReview ? "group" : undefined} aria-label={needsReview ? labels.lowConfidence : undefined} className={`flex flex-col gap-2 border-b p-2.5 last:border-b-0 ${needsReview ? "rounded-xl border-2 border-warn bg-warn-tint" : "border-line"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="flex-1 text-[15px] font-semibold text-ink">{line.description}</span>
                <span className="text-base font-bold">{formatAmount(line.amountCents)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs ${line.confidence < 0.7 ? "font-bold text-warn" : "text-ink-muted"}`}>
                  {line.reason}
                  {line.confidence < 0.7 ? ` · ${labels.lowConfidence}` : ""}
                </span>
                <select
                  value={isExcluded ? "exclude" : category}
                  onChange={(e) => updateCategory(line.i, e.target.value as ExpenseCategoryCode | "exclude")}
                  className="rounded-full border border-line bg-card px-2.5 py-1 text-[13px] font-semibold"
                >
                  {EXPENSE_CATEGORY_CODES.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabels[c]}
                    </option>
                  ))}
                  <option value="exclude">{labels.exclude}</option>
                </select>
              </div>
            </div>
          );
        })}
      </div>
      {saveStatus === "error" && <p role="alert" className="text-sm text-warn">{labels.saveError}</p>}
      <button
        type="button"
        onClick={handleSaveAll}
        disabled={saveStatus === "saving" || saveStatus === "saved" || missingLine}
        className="h-14 rounded-full bg-accent text-lg font-bold text-on-accent disabled:opacity-40"
      >
        {saveStatus === "saved" ? labels.saved : labels.saveAll}
      </button>
    </div>
  );
}
