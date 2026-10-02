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
