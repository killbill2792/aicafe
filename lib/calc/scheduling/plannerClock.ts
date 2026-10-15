import { normalizeSchedulingWallTime } from "./availability";

/** Exact civil-time conversion without a guessed fixed UTC offset. A nonexistent
 * (spring forward) or repeated (fall back) local wall time is not silently
 * chosen: the owner must provide a disambiguated plan before publishing.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  let formatter = formatterCache.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    formatterCache.set(zone, formatter);
  }
  return formatter;
}
export function localParts(instantMs: number, zone: string) {
  const values = Object.fromEntries(formatter(zone).formatToParts(new Date(instantMs))
    .filter(x => x.type !== "literal").map(x => [x.type, Number(x.value)]));
  const y = values.year, m = values.month, d = values.day;
  const hour = values.hour, minute = values.minute;
  return {
    date: `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`,
    hour, minute,
    weekday: new Date(Date.UTC(y, m-1, d)).getUTCDay(),
  };
}
export function civilDateAdd(date: string, days: number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(days))
    throw new Error("Invalid local calendar date");
  const ms = Date.parse(date + "T00:00:00.000Z");
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10) !== date)
    throw new Error("Invalid local calendar date");
  return new Date(ms + days * 86_400_000).toISOString().slice(0,10);
}
export function weekday(date: string) {
  return new Date(civilDateAdd(date,0) + "T00:00:00Z").getUTCDay();
}
export function wallToUtc(date: string, wall: string, zone: string): number {
  civilDateAdd(date, 0);
  const time = normalizeSchedulingWallTime(wall);
  const [hours, minutes] = time.split(":").map(Number);
  const nominal = Date.parse(date + "T00:00:00Z") + (hours*60+minutes)*60_000;
  // Candidate offsets vary across IANA transitions (including sub-hour zones).
  // Testing both sides of the target date finds each applicable offset.
  const offsets = new Set<number>();
  for (let h=-36;h<=36;h+=3) {
    const sample = nominal + h*3_600_000;
    const part = localParts(sample,zone);
    const projected = Date.parse(part.date+"T00:00:00Z")+
      (part.hour*60+part.minute)*60_000;
    offsets.add(projected-sample);
  }
  const matches = [...offsets].map(offset=>nominal-offset).filter(instant=>{
    const p=localParts(instant,zone);
    return p.date===date && p.hour===hours && p.minute===minutes;
  });
  if (matches.length !== 1) throw new Error(matches.length===0
    ? "nonexistent_local_time" : "ambiguous_local_time");
  return matches[0];
}
export function windowUtc(date: string, start: string, end: string,
  overnight: boolean, zone: string) {
  const startAt = wallToUtc(date,start,zone);
  const endAt = wallToUtc(overnight?civilDateAdd(date,1):date,end,zone);
  if (endAt<=startAt || endAt-startAt>24*3_600_000)
    throw new Error("invalid_window_duration");
  return { startAt, endAt };
}
export function utcIso(ms: number): string {
  return new Date(ms).toISOString();
}
export function parseUtcInstant(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    throw new Error("Expected canonical UTC ISO instant");
  const ms=Date.parse(value);
  if (!Number.isFinite(ms) || ms%60000!==0) throw new Error("Expected UTC minute precision");
  return ms;
}
