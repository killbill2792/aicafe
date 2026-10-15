/** PR1B UI displays civil-time work limits in hours, but PR1A persists integer minutes. */
export function minutesToHourInput(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "";
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new Error("Invalid minutes");
  return String(Number((minutes / 60).toFixed(6)));
}

export function hourInputToMinutes(value: string, maxMinutes: number, required = false): number | null {
  if (value.trim() === "" && !required) return null;
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) throw new Error("Invalid hours");
  const hours = Number(value);
  const minutes = Math.round(hours * 60);
  if (!Number.isFinite(hours) || !Number.isSafeInteger(minutes) ||
      minutes < 0 || minutes > maxMinutes) throw new Error("Invalid hours");
  return minutes;
}
