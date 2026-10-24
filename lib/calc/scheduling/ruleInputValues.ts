/** Convert owner-entered rule durations without changing the persisted minute/basis-point units. */
export function normalizeDigits(value: string): string {
 return value.replace(/[٠-٩۰-۹]/g, digit => {
  const cp = digit.codePointAt(0)!;
  return String(cp >= 0x6f0 ? cp - 0x6f0 : cp - 0x660);
 });
}
export function minutesToParts(minutes: number): {hours: number; minutes: number} {
 return {hours: Math.floor(minutes / 60), minutes: minutes % 60};
}
export function partsToMinutes(hoursText: string, minutesText: string, min: number, max: number): number | null {
 const hours = normalizeDigits(hoursText.trim());
 const minutes = normalizeDigits(minutesText.trim());
 if (!/^\d+$/.test(hours) || !/^\d+$/.test(minutes)) return null;
 const result = Number(hours) * 60 + Number(minutes);
 return Number.isSafeInteger(result) && result >= min && result <= max ? result : null;
}
export function wholeRuleValue(value: string, min: number, max: number): number | null {
 const text = normalizeDigits(value.trim());
 if (!/^\d+$/.test(text)) return null;
 const result = Number(text);
 return Number.isSafeInteger(result) && result >= min && result <= max ? result : null;
}
export function multiplierToBasisPoints(value: string): number | null {
 const text = normalizeDigits(value.trim()).replace(/[,.٫]/g, character => character === "," || character === "٫" ? "." : character);
 if (!/^(?:\d+)(?:\.\d{1,4})?$/.test(text)) return null;
 const result = Math.round(Number(text) * 10_000);
 return Number.isSafeInteger(result) && result >= 10_000 && result <= 50_000 ? result : null;
}
export function basisPointsToMultiplier(value: number): string {
 return String(value / 10_000);
}

export function employerCostPercentFromInput(value: string): number | null {
 const normalized = normalizeDigits(value.trim()).replace(/[,.٫]/g, character => character === "," || character === "٫" ? "." : character);
 if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
 const percent = Number(normalized);
 return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
}
