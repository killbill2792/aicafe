import "server-only";
import Papa from "papaparse";
import { retainProviderPayload } from "@/lib/externalData/retainPayload";

function permittedColumn(header: string): boolean {
  return Object.hasOwn(retainProviderPayload({ [header]: "" }) as object, header)
    && retainProviderPayload(header) === header;
}

/** Keep column positions, duplicate headings, blanks and short rows as supplied. */
export function retainSalesCsv(csv: string) {
  const [headers = [], ...rows] = Papa.parse<string[]>(csv, { skipEmptyLines: true }).data;
  const allowed = headers.map(permittedColumn);
  const retainCell = (cell: string) => retainProviderPayload(cell) as string;
  return {
    headers: headers.filter((_, index) => allowed[index]).map(retainCell),
    rows: rows.map(row => row.filter((_, index) => allowed[index] !== false).map(retainCell)),
  };
}

/** Use the original heading for credential screening even if Papa renames a duplicate. */
export function readSalesCsvForImport(csv: string) {
  const { data, meta } = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  const original = meta.renamedHeaders ?? {};
  const fields = new Set((meta.fields ?? []).filter(field => permittedColumn(Object.hasOwn(original, field) ? original[field] : field)));
  const rows = data.map(row => Object.fromEntries(Object.entries(row).filter(([field]) => fields.has(field))));
  return { fields, rows: retainProviderPayload(rows) as typeof data };
}
