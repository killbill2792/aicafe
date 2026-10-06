"use client";

import { useMemo, useState, useTransition } from "react";
import { detectCsvColumns } from "@/lib/pos/csv/csvUtils";
import { parseProcessingFeesCsv, type ProcessingFeeColumnMapping } from "@/lib/pos/csv/parseProcessingFeesCsv";
import { readUploadedFileAsCsvText, UPLOAD_FILE_ACCEPT } from "@/lib/pos/csv/readUploadedFile";
import { importProcessingFeeRows, saveMapping, type ProcessingFeeImportSummary } from "@/lib/actions/csvImport";

export default function ProcessingFeeImporter({
  initialMapping,
  labels,
}: {
  initialMapping: ProcessingFeeColumnMapping | null;
  labels: Record<"uploadPrompt" | "chooseFile" | "mapTitle" | "fieldDate" | "fieldProcessingFee" | "none" | "preview" | "import" | "imported" | "result" | "invalid", string>;
}) {
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Partial<ProcessingFeeColumnMapping>>(initialMapping ?? {});
  const [summary, setSummary] = useState<ProcessingFeeImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function handleFile(file: File) {
    const { headers: nextHeaders, rows: nextRows } = detectCsvColumns(await readUploadedFileAsCsvText(file));
    setHeaders(nextHeaders);
    setRows(nextRows);
    if (initialMapping && Object.values(initialMapping).every((column) => nextHeaders.includes(column))) setMapping(initialMapping);
  }

  const complete = Boolean(mapping.date && mapping.processingFee);
  const parsed = useMemo(() => complete ? parseProcessingFeesCsv(rows, mapping as ProcessingFeeColumnMapping) : { valid: [], invalidRows: 0 }, [complete, mapping, rows]);

  function handleImport() {
    if (!complete || parsed.valid.length === 0) return;
    setError(null);
    startTransition(async () => {
      await saveMapping("processing_fees", mapping as ProcessingFeeColumnMapping, "Processing fee report");
      const result = await importProcessingFeeRows(parsed.valid, parsed.invalidRows);
      if (result.ok) setSummary(result.summary ?? null);
      else setError(result.error ?? null);
    });
  }

  if (!headers) {
    return (
      <label className="flex min-h-48 cursor-pointer flex-col items-center justify-center gap-3 rounded-card-lg border-2 border-dashed border-line bg-card p-8 text-center focus-within:ring-2 focus-within:ring-ink">
        <span className="text-[17px] font-semibold text-ink">{labels.uploadPrompt}</span>
        <span className="flex min-h-12 items-center rounded-full bg-ink px-5 text-base font-bold text-paper">{labels.chooseFile}</span>
        <input type="file" accept={UPLOAD_FILE_ACCEPT} className="sr-only" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleFile(file);
        }} />
      </label>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
        <h2 className="text-lg font-bold">{labels.mapTitle}</h2>
        {(["date", "processingFee"] as const).map((field) => (
          <label key={field} className="flex flex-col gap-2 text-[17px] font-semibold sm:flex-row sm:items-center sm:justify-between">
            {field === "date" ? labels.fieldDate : labels.fieldProcessingFee}
            <select value={mapping[field] ?? ""} onChange={(event) => setMapping((current) => ({ ...current, [field]: event.target.value || undefined }))} className="h-12 min-w-0 rounded-xl border border-line bg-paper px-3 text-[17px] sm:max-w-[60%] sm:flex-1">
              <option value="">{labels.none}</option>
              {headers.map((header) => <option key={header} value={header}>{header}</option>)}
            </select>
          </label>
        ))}
      </section>

      {complete && <p className="px-2 text-[17px] text-ink-muted">{labels.preview.replace("{count}", String(parsed.valid.length))}</p>}
      {complete && parsed.invalidRows > 0 && <p className="rounded-xl bg-warn-tint p-3 text-[17px] font-semibold text-warn">{labels.invalid.replace("{count}", String(parsed.invalidRows))}</p>}
      {summary && <p className="rounded-card-lg bg-good-tint p-4 text-[17px] font-semibold text-good">{labels.result.replace("{count}", String(summary.importedDates))}</p>}
      {error && <p className="px-2 text-[17px] text-warn">{error}</p>}
      <button type="button" onClick={handleImport} disabled={!complete || parsed.valid.length === 0 || isPending} className="min-h-14 rounded-full bg-ink px-5 text-lg font-bold text-paper disabled:opacity-40">
        {summary ? labels.imported : labels.import}
      </button>
    </div>
  );
}
