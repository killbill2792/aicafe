"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { reviewStatementCsv } from "@/lib/actions/statementReview";
import { saveCategorizedLines, type ReviewLine } from "@/lib/actions/expenses";
import { readUploadedFileAsCsvText, UPLOAD_FILE_ACCEPT } from "@/lib/pos/csv/readUploadedFile";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import { formatCents } from "@/lib/calc";

type ReviewableLine = ReviewLine & { correctedCategory?: ExpenseCategoryCode };
type BalanceCheck = { openingCents: number; closingCents: number; sumCents: number; ok: boolean };
type ReviewState =
  | { ok: true; lines: ReviewableLine[]; balanceCheck: BalanceCheck | null; unrecognizedColumns: boolean }
  | { ok: false; error: string };

export default function StatementUploader({
  categoryLabels,
  labels,
}: {
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
  };
}) {
  const router = useRouter();
  const [state, setState] = useState<ReviewState | null>(null);
  const [isPending, startTransition] = useTransition();
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  function handleFile(file: File) {
    startTransition(async () => {
      const text = await readUploadedFileAsCsvText(file);
      const result = await reviewStatementCsv(text);
      setState(result);
    });
  }

  function updateCategory(i: number, category: ExpenseCategoryCode | "exclude") {
    if (!state?.ok) return;
    setState({ ...state, lines: state.lines.map((l) => (l.i === i ? { ...l, correctedCategory: category === "exclude" ? undefined : category, category: category === "exclude" ? "exclude" : l.category } : l)) });
  }

  function handleSaveAll() {
    if (!state?.ok) return;
    setSaveStatus("saving");
    startTransition(async () => {
      const result = await saveCategorizedLines("statement", state.lines);
      if (result.ok) {
        setSaveStatus("saved");
        setTimeout(() => router.push("/money"), 900);
      } else {
        setSaveStatus("error");
      }
    });
  }

  if (!state) {
    return (
      <label className="flex flex-col items-center gap-3 rounded-card-lg border-2 border-dashed border-line bg-card p-8 text-center">
        <span className="text-base font-semibold text-ink">{isPending ? labels.reading : labels.uploadPrompt}</span>
        <span className="rounded-full bg-ink px-5 py-2.5 text-sm font-bold text-paper">{labels.chooseFile}</span>
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
      <div className="flex flex-col gap-2 rounded-card-lg bg-card p-2">
        {state.lines.map((line) => {
          const category = line.correctedCategory ?? (line.category === "exclude" ? "other" : line.category);
          const isExcluded = line.category === "exclude" && !line.correctedCategory;
          return (
            <div key={line.i} className="flex flex-col gap-2 border-b border-[#EFE7DB] p-2.5 last:border-b-0">
              <div className="flex items-center justify-between gap-2">
                <span className="flex-1 text-[15px] font-semibold text-ink">{line.description}</span>
                <span className="text-base font-bold">{formatCents(line.amountCents)}</span>
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
      <button
        type="button"
        onClick={handleSaveAll}
        disabled={saveStatus === "saving"}
        className="h-14 rounded-full bg-ink text-lg font-bold text-paper disabled:opacity-40"
      >
        {saveStatus === "saved" ? labels.saved : labels.saveAll}
      </button>
    </div>
  );
}
