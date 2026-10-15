/** Exact duration editor: hours:minutes -> canonical PR1A integer minutes.
 * Never round a fractional minute to zero or past a hard cap.
 */
export function minutesToHourInput(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "";
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new Error("Invalid minutes");
  return `${Math.floor(minutes/60)}:${String(minutes%60).padStart(2,"0")}`;
}
export function hourInputToMinutes(value: string, maxMinutes: number, required = false): number | null {
  if (value.trim() === "" && !required) return null;
  const match = /^(\d{1,3}):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new Error("Enter hours:minutes");
  const total=Number(match[1])*60+Number(match[2]);
  if (!Number.isSafeInteger(total) || total < 0 || total > maxMinutes)
    throw new Error("Duration outside allowed range");
  return total;
}
