"use client";

import { useMemo, useState, useTransition } from "react";
import { detectCsvColumns } from "@/lib/pos/csv/csvUtils";
import { parseLaborCsv, type LaborColumnMapping } from "@/lib/pos/csv/parseLaborCsv";
import { readUploadedFileAsCsvText, UPLOAD_FILE_ACCEPT } from "@/lib/pos/csv/readUploadedFile";
import { saveMapping, importLaborRows, type LaborImportSummary } from "@/lib/actions/csvImport";
import { NEW_EMPLOYEE } from "@/lib/constants";

const FIELDS: { key: keyof LaborColumnMapping; required: boolean }[] = [
  { key: "employee", required: true },
  { key: "date", required: true },
  { key: "clockIn", required: true },
  { key: "clockOut", required: true },
  { key: "hourlyWage", required: true },
];

export default function LaborCsvImporter({
  initialMapping,
  existingEmployees,
  labels,
}: {
  initialMapping: LaborColumnMapping | null;
  existingEmployees: { id: string; name: string }[];
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
    matchStaffTitle: string;
    matchStaffHint: string;
    addAsNewEmployee: string;
  };
}) {
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Partial<LaborColumnMapping>>(initialMapping ?? {});
  const [employeeChoices, setEmployeeChoices] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "imported">("idle");
  const [count, setCount] = useState(0);
  const [summary, setSummary] = useState<LaborImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    const text = await readUploadedFileAsCsvText(file);
    const { headers: h, rows: r } = detectCsvColumns(text);
    setHeaders(h);
    setRows(r);
    if (initialMapping && Object.values(initialMapping).every((v) => !v || h.includes(v))) {
      setMapping(initialMapping);
    }
  }

  const complete = FIELDS.filter((f) => f.required).every((f) => mapping[f.key]);
  const parsedRows = useMemo(() => (complete ? parseLaborCsv(rows, mapping as LaborColumnMapping) : []), [complete, rows, mapping]);

  // A name is ambiguous (needs the owner's eyes) unless exactly one existing employee's name
  // matches it case-insensitively — zero matches could be a new hire or a nickname/typo for
  // someone who already exists; two-or-more matches means real people share that exact name.
  // Either way we don't guess: `lib/actions/csvImport.ts`'s `resolveEmployeeIds` applies the same
  // exact-match rule server-side and falls back to whatever's picked here.
  const ambiguousNames = useMemo(() => {
    const seen = new Set<string>();
    const list: { name: string; candidates: { id: string; name: string }[] }[] = [];
    for (const r of parsedRows) {
      const key = r.employee.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const candidates = existingEmployees.filter((e) => e.name.trim().toLowerCase() === key);
      if (candidates.length !== 1) list.push({ name: r.employee, candidates });
    }
    return list;
  }, [parsedRows, existingEmployees]);

  function choiceFor(name: string): string {
    return employeeChoices[name.trim().toLowerCase()] ?? NEW_EMPLOYEE;
  }

  function handleImport() {
    if (!complete) return;
    setError(null);
    startTransition(async () => {
      await saveMapping("labor", mapping as LaborColumnMapping, "Labor time entries export");
      const choices = Object.fromEntries(ambiguousNames.map((a) => [a.name.trim().toLowerCase(), choiceFor(a.name)]));
      const result = await importLaborRows(parsedRows, choices);
      if (result.ok) {
        setStatus("imported");
        setCount(result.imported);
        setSummary(result.summary ?? null);
      } else {
        setError(result.error ?? null);
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

      {complete && status === "idle" && <p className="px-2 text-sm text-ink-muted">{labels.preview.replace("{count}", String(parsedRows.length))}</p>}

      {complete && status === "idle" && ambiguousNames.length > 0 && (
        <section className="flex flex-col gap-2.5 rounded-card-lg bg-card p-4">
          <h2 className="text-base font-bold">{labels.matchStaffTitle}</h2>
          <p className="text-sm text-ink-muted">{labels.matchStaffHint}</p>
          {ambiguousNames.map(({ name, candidates }) => (
            <label key={name} className="flex items-center justify-between gap-2 text-sm font-semibold">
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <select
                value={choiceFor(name)}
                onChange={(e) => setEmployeeChoices((c) => ({ ...c, [name.trim().toLowerCase()]: e.target.value }))}
                className="h-11 w-[180px] shrink-0 rounded-xl border border-line px-2 text-sm"
              >
                <option value={NEW_EMPLOYEE}>{labels.addAsNewEmployee}</option>
                {(candidates.length > 1 ? candidates : existingEmployees).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </section>
      )}

      {summary && (
        <p className="rounded-card-lg bg-card p-4 text-sm font-semibold text-good">
          {summary.dateFrom && summary.dateTo
            ? labels.resultSummary.replace("{imported}", String(summary.imported)).replace("{rowsInFile}", String(summary.rowsInFile)).replace("{dateFrom}", summary.dateFrom).replace("{dateTo}", summary.dateTo)
            : labels.resultSummaryNoDates.replace("{imported}", String(summary.imported)).replace("{rowsInFile}", String(summary.rowsInFile))}
        </p>
      )}

      {error && <p className="px-2 text-sm text-warn">{error}</p>}

      <button
        type="button"
        onClick={handleImport}
        disabled={!complete || isPending}
        className="h-14 rounded-full bg-ink text-lg font-bold text-paper disabled:opacity-40"
      >
        {status === "imported" ? `${labels.imported} (${count})` : labels.import}
      </button>
    </div>
  );
}
