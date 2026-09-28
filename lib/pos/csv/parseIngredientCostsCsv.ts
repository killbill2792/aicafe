import { toCents, toDateStr } from "./csvUtils";

export type IngredientCostColumnMapping = {
  name: string;
  costPerUnit: string;
  effectiveDate?: string;
  unitNote?: string; // informational only — not used for conversion, see parseIngredientCostsCsv
};

export type NormalizedIngredientCostRow = {
  name: string;
  costPerUnitCents: number;
  effectiveFrom: string; // YYYY-MM-DD
  unitNote: string | null;
};

/**
 * Generic inventory/ingredient-cost export importer — built for sites with no API (e.g. the
 * owner downloads a nightly report from an inventory management tool and uploads it here), same
 * mapping-driven pattern as the sales/labor CSV importers. Deliberately does NOT convert units
 * (lb/oz/gal → our g/ml base units) — no inventory export format was available to build against,
 * so "cost per unit" here is assumed to already mean cost per the ingredient's existing base unit
 * (g, ml, or each). The review screen shows the raw unit text the owner mapped, for a sanity
 * check before saving, and a new ingredient's base unit is chosen explicitly at review time.
 */
export function parseIngredientCostsCsv(rows: Record<string, string>[], mapping: IngredientCostColumnMapping, todayDateStr: string): NormalizedIngredientCostRow[] {
  return rows
    .map((row) => ({
      name: (row[mapping.name] ?? "").trim(),
      costPerUnitCents: toCents(row[mapping.costPerUnit] ?? "0"),
      effectiveFrom: mapping.effectiveDate ? toDateStr(row[mapping.effectiveDate] ?? "") || todayDateStr : todayDateStr,
      unitNote: mapping.unitNote ? (row[mapping.unitNote] ?? "").trim() || null : null,
    }))
    .filter((r) => r.name && r.costPerUnitCents > 0);
}
