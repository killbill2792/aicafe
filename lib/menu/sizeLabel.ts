/** True when a size label is just a bare number — "16", "12.5" — and nothing else. That's
 * ambiguous (16 what? oz? ml? g?) and must not be silently assumed to mean ounces. Named sizes
 * ("Small", "12 oz", "350 ml", "1 piece") are never ambiguous and pass straight through. */
export function isAmbiguousNumericSizeLabel(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value.trim());
}

export const SIZE_LABEL_UNIT_CHOICES = ["oz", "ml", "g", "each"] as const;
export type SizeLabelUnitChoice = (typeof SIZE_LABEL_UNIT_CHOICES)[number] | "keep";

/** Turns a bare number plus the owner's clarification into the actual stored/display label —
 * "16" + "oz" → "16 oz"; "16" + "keep" → "16" (the owner explicitly meant the number itself,
 * not a unit). */
export function resolveSizeLabel(rawValue: string, choice: SizeLabelUnitChoice): string {
  const trimmed = rawValue.trim();
  return choice === "keep" ? trimmed : `${trimmed} ${choice}`;
}

const NAMED_SIZE_ORDER = ["kid", "kids", "short", "small", "tall", "medium", "grande", "large", "venti", "extra large"];

export function compareOwnerSizeLabels(a: string | null, b: string | null): number {
  const left = (a ?? "").trim().normalize("NFKC").toLocaleLowerCase("en-US");
  const right = (b ?? "").trim().normalize("NFKC").toLocaleLowerCase("en-US");
  const leftNamed = NAMED_SIZE_ORDER.indexOf(left);
  const rightNamed = NAMED_SIZE_ORDER.indexOf(right);
  if (leftNamed >= 0 && rightNamed >= 0) return leftNamed - rightNamed;
  const numeric = (value: string) => value.match(/^(\d+(?:\.\d+)?)(?:\s*(fl\s*oz|oz|ml|l|g|kg))?$/i);
  const lm = numeric(left); const rm = numeric(right);
  if (lm && rm && (lm[2] ?? "").replace(/\s/g, "") === (rm[2] ?? "").replace(/\s/g, "")) return Number(lm[1]) - Number(rm[1]);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function stableSortSizes<T extends { id: string; sizeLabel: string | null }>(sizes: T[]): T[] {
  return [...sizes].sort((a, b) => compareOwnerSizeLabels(a.sizeLabel, b.sizeLabel) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
