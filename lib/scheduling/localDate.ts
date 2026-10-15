/** Civil date in a verified IANA timezone. Never infer wall date from UTC
 * or reuse the café timezone for a location on another calendar day.
 */
export function localDateInZone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US",{
    timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit",
  }).formatToParts(now);
  const value=(key:string)=>parts.find(p=>p.type===key)?.value;
  const year=value("year"),month=value("month"),day=value("day");
  if (!year || !month || !day) throw new Error("Invalid IANA timezone");
  return `${year}-${month}-${day}`;
}
