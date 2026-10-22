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
    s = (dot > comma ? s.replace(/,/g, "") : s.replace(/\./g, "").replace(",", "."));
  } else if (comma >= 0) {
    const frac = s.length - comma - 1;
    s = frac === 3 && s.indexOf(",") === comma ? s.replace(",", "")
      : locale === "en" && frac === 3 ? s.replace(/,/g, "")
      : s.replace(/,/g, ".");
  } else if (dot >= 0) {
    const frac = s.length - dot - 1;
    if (frac === 3 && s.indexOf(".") === dot) s = s.replace(".", "");
  }
  return Number(s);
}
const numeric = /(?<![\p{L}\p{N}_])(?:[$€£]|USD\s*|EUR\s*|GBP\s*|ر\.س\s*|د\.إ\s*)?[-+−]?[٠-٩۰-۹\d]+(?:[.,٬٫\s\u00a0\u202f][٠-٩۰-۹\d]+)*(?:\s*[%٪])?(?![\p{L}\p{N}_])/gu;
function candidates(text: string, locale: AgentLocale): Array<UnverifiedNumber & { value: number }> {
  const found: Array<UnverifiedNumber & { value: number }> = [];
  for (const m of text.matchAll(numeric)) {
    const token = m[0].trim(), money = /^(?:[$€£]|USD|EUR|GBP|ر\.س|د\.إ)/iu.test(token);
    const percent = /[%٪]$/.test(token);
    const raw = token.replace(/^(?:[$€£]|USD|EUR|GBP|ر\.س|د\.إ)\s*/iu, "").replace(/[%٪]$/, "").trim().replace("−", "-");
    const value = decimal(raw, locale);
    if (!Number.isFinite(value)) continue;
    const kind: Kind = money ? "money" : percent ? "percent" : "number";
    found.push({ text: token, start: m.index, end: m.index + m[0].length, kind,
      value: kind === "money" ? Math.round(value * 100) : kind === "percent" ? Math.round(value * 100) : value });
  }
  return found;
}
function allowFromData(data: unknown, allowed: Record<Kind, Set<number>>, key = ""): void {
  if (Array.isArray(data)) { data.forEach(value => allowFromData(value, allowed, key)); return; }
  if (data && typeof data === "object") {
    for (const [k, v] of Object.entries(data)) {
      if (k === "labels") continue;
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
/** Read-only verifier: never rewrites the owner's or model's prose. */
export function checkNumbers(text: string, ownerText: string, results: readonly AgentToolResult[], locale: AgentLocale): UnverifiedNumber[] {
  const allowed: Record<Kind, Set<number>> = { money: new Set(), percent: new Set(), number: new Set() };
  results.forEach(result => allowFromData(result, allowed));
  candidates(ownerText, locale).forEach(v => allowed[v.kind].add(v.value));
  return candidates(text, locale).filter(v => !allowed[v.kind].has(v.value))
    .map(({text: token,start,end,kind}) => ({ text: token, start, end, kind }));
}
