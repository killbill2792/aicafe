"use client";

import { useMemo, useState, useTransition } from "react";
import { detectCsvColumns } from "@/lib/pos/csv/csvUtils";
import { parseIngredientCostsCsv, type IngredientCostColumnMapping } from "@/lib/pos/csv/parseIngredientCostsCsv";
import { readUploadedFileAsCsvText, UPLOAD_FILE_ACCEPT } from "@/lib/pos/csv/readUploadedFile";
import { saveMapping, importIngredientCostRows, type IngredientCostImportRow } from "@/lib/actions/csvImport";
import { formatCents } from "@/lib/calc";

const FIELDS: { key: keyof IngredientCostColumnMapping; required: boolean }[] = [
  { key: "name", required: true },
  { key: "costPerUnit", required: true },
  { key: "unitNote", required: false },
  { key: "effectiveDate", required: false },
];

type BaseUnit = "g" | "ml" | "each";

function guessBaseUnit(name: string): BaseUnit {
  const n = name.toLowerCase();
  if (/milk|cream|syrup|juice|sauce|oil/.test(n)) return "ml";
  if (/cup|lid|sleeve|napkin|straw|bag/.test(n)) return "each";
  return "g";
}

export default function IngredientCostImporter({
  initialMapping,
  existingNames,
  todayDateStr,
  labels,
}: {
  initialMapping: IngredientCostColumnMapping | null;
  existingNames: string[];
  todayDateStr: string;
  labels: {
    uploadPrompt: string;
    chooseFile: string;
    mapTitle: string;
    fieldLabels: Record<string, string>;
    none: string;
    preview: string;
    import: string;
    imported: string;
    newIngredientsTitle: string;
    newIngredientsHint: string;
    unitG: string;
    unitMl: string;
    unitEach: string;
  };
}) {
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Partial<IngredientCostColumnMapping>>(initialMapping ?? {});
  const [unitChoices, setUnitChoices] = useState<Record<string, BaseUnit>>({});
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "imported">("idle");
  const [count, setCount] = useState(0);
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
  const parsedRows = useMemo(() => (complete ? parseIngredientCostsCsv(rows, mapping as IngredientCostColumnMapping, todayDateStr) : []), [complete, rows, mapping, todayDateStr]);

  const newNames = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const r of parsedRows) {
      const key = r.name.toLowerCase();
      if (!existingNames.includes(key) && !seen.has(key)) {
        seen.add(key);
        list.push(r.name);
      }
    }
    return list;
  }, [parsedRows, existingNames]);

  function unitFor(name: string): BaseUnit {
    return unitChoices[name.toLowerCase()] ?? guessBaseUnit(name);
  }

  function handleImport() {
    if (!complete) return;
    setError(null);
    startTransition(async () => {
      await saveMapping("ingredients", mapping as IngredientCostColumnMapping, "Inventory cost export");
      const importRows: IngredientCostImportRow[] = parsedRows.map((r) => ({ ...r, baseUnitForNew: unitFor(r.name) }));
      const result = await importIngredientCostRows(importRows);
      if (result.ok) {
        setStatus("imported");
        setCount(result.imported);
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
              className="h-11 max-w-[60%] flex-1 rounded-xl border border-line px-2 text-sm"
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

      {complete && <p className="px-2 text-sm text-ink-muted">{labels.preview.replace("{count}", String(parsedRows.length))}</p>}

      {newNames.length > 0 && (
        <section className="flex flex-col gap-2.5 rounded-card-lg bg-card p-4">
          <h2 className="text-base font-bold">{labels.newIngredientsTitle}</h2>
          <p className="text-sm text-ink-muted">{labels.newIngredientsHint}</p>
          {newNames.map((name) => (
            <label key={name} className="flex items-center justify-between gap-2 text-sm font-semibold">
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <select
                value={unitFor(name)}
                onChange={(e) => setUnitChoices((u) => ({ ...u, [name.toLowerCase()]: e.target.value as BaseUnit }))}
                className="h-11 w-[136px] shrink-0 rounded-xl border border-line px-2 text-sm"
              >
                <option value="g">{labels.unitG}</option>
                <option value="ml">{labels.unitMl}</option>
                <option value="each">{labels.unitEach}</option>
              </select>
            </label>
          ))}
        </section>
      )}

      {complete && parsedRows.length > 0 && (
        <section className="flex flex-col gap-1.5 rounded-card-lg bg-card p-4">
          {parsedRows.slice(0, 8).map((r, i) => (
            <div key={i} className="flex items-center justify-between text-sm">
              <span className="truncate">{r.name}</span>
              <span className="font-semibold">{formatCents(r.costPerUnitCents)}</span>
            </div>
          ))}
        </section>
      )}

      {error && <p className="px-2 text-sm text-warn">{error}</p>}

      <button
        type="button"
        onClick={handleImport}
        disabled={!complete || isPending || parsedRows.length === 0}
        className="h-14 rounded-full bg-ink text-lg font-bold text-paper disabled:opacity-40"
      >
        {status === "imported" ? `${labels.imported} (${count})` : labels.import}
      </button>
    </div>
  );
}
