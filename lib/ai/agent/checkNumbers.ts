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
const currency = "(?:[$€£]|USD|EUR|GBP|ر\\.س|د\\.إ|دولار)";
const digits = "[-+−]?[٠-٩۰-۹\\d]+";
function numberPattern(locale: AgentLocale): RegExp {
  // Ordinary spaces separate words (and numbers); localized nonbreaking
  // grouping spaces are allowed between digits only in ES/AR.
  const separators = locale === "en" ? "[.,٬٫]" : "[.,٬٫\\u00a0\\u202f]";
  const number = digits + "(?:" + separators + "[٠-٩۰-۹\\d]+)*";
  return new RegExp("(?<![\\p{L}\\p{N}_])(?:" + currency + "\\s*)?" + number +
    "(?:\\s*(?:[%٪]|" + currency + "))?(?![\\p{L}\\p{N}_])", "gu");
}
const months = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)";
const monthBefore = new RegExp(months + "[\\s,]*$", "iu");
const monthAfter = new RegExp("^\\s*(?:de\\s+)?" + months + "(?!\\p{L})", "iu");
const isoDate = /[٠-٩۰-۹\d]{4}[-/][٠-٩۰-۹\d]{1,2}[-/][٠-٩۰-۹\d]{1,2}/gu;
function isCalendarNumber(text: string, start: number, end: number, value: number, kind: Kind): boolean {
  if (kind !== "number" || !Number.isInteger(value)) return false;
  if (value >= 2000 && value <= 2100) return true;
  if (value >= 1 && value <= 31) {
    const before = text.slice(Math.max(0, start - 28), start);
    const after = text.slice(end, end + 28);
    if (monthBefore.test(before) || monthAfter.test(after)) return true;
  }
  return [...text.matchAll(isoDate)].some(match =>
    start < match.index + match[0].length && end > match.index);
}
function candidates(text: string, locale: AgentLocale): Array<UnverifiedNumber & { value: number; wholePercent: boolean }> {
  const found: Array<UnverifiedNumber & { value: number; wholePercent: boolean }> = [];
  for (const m of text.matchAll(numberPattern(locale))) {
    const token = m[0].trim(), money = new RegExp(currency, "u").test(token);
    const percent = /[%٪]$/.test(token);
    const raw = token.replace(new RegExp(currency, "gu"), "").replace(/[%٪]/g, "").trim().replace("−", "-");
    const value = decimal(raw, locale);
    if (!Number.isFinite(value)) continue;
    const kind: Kind = money ? "money" : percent ? "percent" : "number";
    if (isCalendarNumber(text, m.index, m.index + m[0].length, value, kind)) continue;
    found.push({ text: token, start: m.index, end: m.index + m[0].length, kind,
      wholePercent: percent && !/[.,٫٬]/.test(raw),
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
/** Report unsupported numbers at their original prose offsets; never change the owner's text. */
export function checkNumbers(text: string, ownerText: string, results: readonly AgentToolResult[], locale: AgentLocale): UnverifiedNumber[] {
  const allowed: Record<Kind, Set<number>> = { money: new Set(), percent: new Set(), number: new Set() };
  results.forEach(r => allowFromData(r, allowed));
  candidates(ownerText, locale).forEach(v => allowed[v.kind].add(v.value));
  return candidates(text, locale).filter(v => ![...allowed[v.kind]].some(x =>
    Math.abs(x - v.value) <= (v.kind === "money" ? 1 : v.kind === "percent" ? v.wholePercent ? 50 : 10 : 0)))
    .map(({ text: token, start, end, kind }) => ({ text: token, start, end, kind }));
}
