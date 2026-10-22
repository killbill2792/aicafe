import type { AgentLocale, AgentToolResult } from "./tools";

export type UnverifiedNumber = { text: string; start: number; end: number; kind: "money" | "percent" | "number" };
type Kind = UnverifiedNumber["kind"];
const ascii = (s: string) => s.replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x660))
  .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x6f0))
  .replace(/٫/g, ".").replace(/٬/g, ",").replace(/٪/g, "%");
function decimal(raw: string, locale: AgentLocale): number {
  let s = ascii(raw).replace(/[\s\u00a0\u202f]/g, "");
  const dot = s.lastIndexOf("."), comma = s.lastIndexOf(",");
  if (dot >= 0 && comma >= 0) {
    s = dot > comma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", ".");
  } else if (comma >= 0) {
    const frac = s.length - comma - 1;
    s = (frac === 3 && locale === "en") ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (dot >= 0) {
    const frac = s.length - dot - 1;
    if (frac === 3 && locale !== "en") s = s.replace(".", "");
  }
  return Number(s);
}
const curr = String.raw`(?:[$€£]|USD|EUR|GBP|ر\.س|د\.إ|دولار)`;
const number = String.raw`[-+−]?[٠-٩۰-۹\d]+(?:[.,٬٫\s\u00a0\u202f][٠-٩۰-۹\d]+)*`;
const numeric = new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:${curr}\s*)?${number}(?:\s*(?:[%٪]|${curr}))?(?![\p{L}\p{N}_])`, "gu");
function candidates(text: string, locale: AgentLocale): Array<UnverifiedNumber & { value: number }> {
  const found: Array<UnverifiedNumber & { value: number }> = [];
  for (const m of text.matchAll(numeric)) {
    const token = m[0].trim();
    const money = new RegExp(curr, "u").test(token);
    const percent = /[%٪]$/.test(token);
    const raw = token.replace(new RegExp(curr, "gu"), "").replace(/[%٪]/g, "").trim().replace("−", "-");
    const value = decimal(raw, locale);
    if (!Number.isFinite(value)) continue;
    const kind: Kind = money ? "money" : percent ? "percent" : "number";
    found.push({ text: token, start: m.index, end: m.index + m[0].length, kind,
      value: kind === "money" || kind === "percent" ? Math.round(value * 100) : value });
  }
  return found;
}
function allowFromData(data: unknown, allowed: Record<Kind, Set<number>>, key = ""): void {
  if (Array.isArray(data)) { data.forEach(v => allowFromData(v, allowed, key)); return; }
  if (data && typeof data === "object") {
    for (const [k,v] of Object.entries(data)) {
      if (k === "labels" || k === "period" || k === "date") continue;
      allowFromData(v, allowed, k);
    }
    return;
  }
  if (typeof data !== "number" || !Number.isFinite(data)) return;
  if (/Cents$/.test(key)) allowed.money.add(Math.round(data));
  else if (/Bps$/.test(key)) allowed.percent.add(Math.round(data));
  else if (/Margin$|Ratio$/.test(key)) allowed.percent.add(Math.round(data * 10000));
  else allowed.number.add(data);
}
/** Return offsets into the original prose, without deleting or altering the sentence. */
export function checkNumbers(text: string, ownerText: string, results: readonly AgentToolResult[], locale: AgentLocale): UnverifiedNumber[] {
  const allowed: Record<Kind, Set<number>> = { money: new Set(), percent: new Set(), number: new Set() };
  results.forEach(r => allowFromData(r, allowed));
  candidates(ownerText, locale).forEach(v => allowed[v.kind].add(v.value));
  return candidates(text, locale).filter(v => ![...allowed[v.kind]].some(x =>
    Math.abs(x - v.value) <= (v.kind === "money" ? 1 : v.kind === "percent" ? 10 : 0)))
    .map(({ text: token, start, end, kind }) => ({ text: token, start, end, kind }));
}
