"use client";

import { useMemo, useState, useTransition } from "react";
import { detectCsvColumns } from "@/lib/pos/csv/csvUtils";
import { parseSalesCsv, type SalesColumnMapping, type SalesRejectReason } from "@/lib/pos/csv/parseSalesCsv";
import { aggregateSalesRows } from "@/lib/pos/csv/aggregateSalesRows";
import { readUploadedFileAsCsvText, UPLOAD_FILE_ACCEPT } from "@/lib/pos/csv/readUploadedFile";
import { saveMapping, startSalesImportJob, finalizeSalesImportJob, cancelStuckImportJob, type SalesImportSummary, type ImportErrorCode } from "@/lib/actions/csvImport";

const FIELDS: { key: keyof SalesColumnMapping; required: boolean }[] = [
  { key: "date", required: true },
  { key: "item", required: true },
  { key: "quantity", required: true },
  { key: "netSales", required: true },
  { key: "category", required: false },
  { key: "processingFee", required: false },
];

type Stage = "idle" | "working" | "done" | "error";

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template);
}

export default function SalesCsvImporter({
  initialMapping,
  labels,
}: {
  initialMapping: SalesColumnMapping | null;
  labels: {
    uploadPrompt: string;
    chooseFile: string;
    mapTitle: string;
    fieldLabels: Record<string, string>;
    none: string;
    preview: string;
    import: string;
    imported: string;
    resultSummary: string;
    resultSummaryNoDates: string;
    unmatchedWarningTitle: string;
    unmatchedWarningHint: string;
    unmatchedRowsCount: string;
    reviewRowsInFile: string;
    rejectedTitle: string;
    rejectedReasons: Record<SalesRejectReason, string>;
    statusStarting: string;
    statusFinalizing: string;
    duplicateNotice: string;
    skippedToastTitle: string;
    skippedToastHint: string;
    tryAgain: string;
    cancelStuckImport: string;
    errors: Record<ImportErrorCode, string>;
  };
}) {
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Partial<SalesColumnMapping>>(initialMapping ?? {});
  const [isPending, startTransition] = useTransition();
  const [stage, setStage] = useState<Stage>("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [summary, setSummary] = useState<SalesImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stuckJobId, setStuckJobId] = useState<string | null>(null);

  async function handleFile(file: File) {
    const text = await readUploadedFileAsCsvText(file);
    const { headers: h, rows: r } = detectCsvColumns(text);
    setHeaders(h);
    setRows(r);
    setStage("idle");
    setSummary(null);
    setError(null);
    // Auto-apply the saved mapping only if every column it references still exists.
    if (initialMapping && Object.values(initialMapping).every((v) => !v || h.includes(v))) {
      setMapping(initialMapping);
    }
  }

  const complete = FIELDS.filter((f) => f.required).every((f) => mapping[f.key]);
  const parsed = useMemo(() => (complete ? parseSalesCsv(rows, mapping as SalesColumnMapping) : { valid: [], rejected: [] }), [complete, rows, mapping]);
  const groups = useMemo(() => aggregateSalesRows(parsed.valid), [parsed.valid]);

  async function runFinalize(jobId: string, attempt = 1) {
    setStatusMessage(labels.statusFinalizing);
    const result = await finalizeSalesImportJob(jobId);
    if (result.ok) {
      setStage("done");
      setSummary(result.summary ?? null);
      return;
    }
    if (attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      await runFinalize(jobId, attempt + 1);
      return;
    }
    setStage("error");
    setStuckJobId(jobId);
    setError(result.errorCode ? interpolate(labels.errors[result.errorCode], result.errorParams) : null);
  }

  function handleImport() {
    if (!complete || parsed.valid.length === 0) return;
    setError(null);
    setStuckJobId(null);
    startTransition(async () => {
      await saveMapping("sales", mapping as SalesColumnMapping, "Sales / product mix export");
      setStage("working");
      setStatusMessage(labels.statusStarting);
      const started = await startSalesImportJob(groups, rows.length, parsed.rejected);
      if (!started.ok) {
        setStage("error");
        setStuckJobId(started.blockingJobId ?? null);
        setError(started.errorCode ? interpolate(labels.errors[started.errorCode], started.errorParams) : null);
        return;
      }
      if (started.duplicate || !started.jobId) {
        setStage("done");
        setSummary(started.summary ?? null);
        return;
      }
      await runFinalize(started.jobId);
    });
  }

  function handleCancelStuck() {
    if (!stuckJobId) return;
    startTransition(async () => {
      const result = await cancelStuckImportJob(stuckJobId);
      setError(result.ok ? null : result.errorCode ? interpolate(labels.errors[result.errorCode]) : null);
      if (result.ok) {
        setStage("idle");
        setStuckJobId(null);
      }
    });
  }

  if (!headers) {
    return (
      <label className="flex flex-col items-center gap-3 rounded-card-lg border-2 border-dashed border-line bg-card p-8 text-center">
        <span className="text-base font-semibold text-ink">{labels.uploadPrompt}</span>
        <span className="rounded-full bg-ink px-5 py-2.5 text-sm font-bold text-paper">{labels.chooseFile}</span>
        <input
          type="file"
          accept={UPLOAD_FILE_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
      </label>
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      <section className="flex flex-col gap-2.5 rounded-card-lg bg-card p-4">
        <h2 className="text-base font-bold">{labels.mapTitle}</h2>
        {FIELDS.map((field) => (
          <label key={field.key} className="flex items-center justify-between gap-2 text-sm font-semibold">
            {labels.fieldLabels[field.key]}
            <select
              value={mapping[field.key] ?? ""}
              onChange={(e) => setMapping((m) => ({ ...m, [field.key]: e.target.value || undefined }))}
              className="h-11 flex-1 max-w-[60%] rounded-xl border border-line px-2 text-sm"
            >
              <option value="">{labels.none}</option>
              {headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
      </section>

      {complete && stage === "idle" && (
        <section className="flex flex-col gap-1.5 rounded-card-lg bg-card p-4">
          <p className="text-sm text-ink-muted">{labels.reviewRowsInFile.replace("{count}", String(rows.length))}</p>
          <p className="text-sm text-ink-muted">{labels.preview.replace("{count}", String(groups.length))}</p>
          {parsed.rejected.length > 0 && (
            <div className="mt-1 flex flex-col gap-1 rounded-xl bg-warn-tint p-3">
              <span className="text-sm font-bold text-warn">{labels.rejectedTitle}</span>
              {parsed.rejected.map((r) => (
                <span key={r.reason} className="text-xs text-[#6E2A07]">
                  {labels.rejectedReasons[r.reason]} ({r.count})
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {stage === "working" && statusMessage && <p className="px-2 text-sm font-semibold text-ink-muted">{statusMessage}</p>}

      {summary && (
        <section className="flex flex-col gap-2 rounded-card-lg bg-card p-4">
          {summary.duplicate && <p className="text-sm font-semibold text-ink-muted">{labels.duplicateNotice}</p>}
          <p className="text-sm font-semibold text-good">
            {summary.dateFrom && summary.dateTo
              ? labels.resultSummary.replace("{imported}", String(summary.imported)).replace("{rowsInFile}", String(summary.rowsInFile)).replace("{dateFrom}", summary.dateFrom).replace("{dateTo}", summary.dateTo)
              : labels.resultSummaryNoDates.replace("{imported}", String(summary.imported)).replace("{rowsInFile}", String(summary.rowsInFile))}
          </p>
          {summary.rejectedRows.length > 0 && (
            <div className="flex flex-col gap-1 rounded-xl bg-warn-tint p-3">
              <span className="text-sm font-bold text-warn">{labels.rejectedTitle}</span>
              {summary.rejectedRows.map((r) => (
                <span key={r.reason} className="text-xs text-[#6E2A07]">
                  {labels.rejectedReasons[r.reason]} ({r.count})
                </span>
              ))}
            </div>
          )}
          {summary.skippedToastConflictDates.length > 0 && (
            <div className="flex flex-col gap-1 rounded-xl bg-warn-tint p-3">
              <span className="text-sm font-bold text-warn">{labels.skippedToastTitle}</span>
              <p className="text-xs text-[#6E2A07]">{labels.skippedToastHint}</p>
              <span className="text-xs text-[#6E2A07]">{summary.skippedToastConflictDates.join(", ")}</span>
            </div>
          )}
          {summary.unmatchedItems.length > 0 && (
            <div className="flex flex-col gap-1 rounded-xl bg-warn-tint p-3">
              <span className="text-sm font-bold text-warn">{labels.unmatchedWarningTitle}</span>
              <p className="text-xs text-[#6E2A07]">{labels.unmatchedWarningHint}</p>
              {summary.unmatchedItems.map((u) => (
                <div key={u.name} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{u.name}</span>
                  <span className="shrink-0 text-xs text-ink-muted">{labels.unmatchedRowsCount.replace("{rows}", String(u.rows))}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {error && (
        <div className="flex flex-col gap-2 px-2">
          <p className="text-sm text-warn">{error}</p>
          {stuckJobId && (
            <button type="button" onClick={handleCancelStuck} disabled={isPending} className="self-start text-sm font-semibold text-ink underline">
              {labels.cancelStuckImport}
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={handleImport}
        disabled={!complete || parsed.valid.length === 0 || isPending || stage === "working"}
        className="h-14 rounded-full bg-ink text-lg font-bold text-paper disabled:opacity-40"
      >
        {stage === "done" ? `${labels.imported} (${summary?.imported ?? 0})` : stage === "error" ? labels.tryAgain : labels.import}
      </button>
    </div>
  );
}
