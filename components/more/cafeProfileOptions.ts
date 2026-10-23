import { isValidLocalTime, type WeeklyHoursInput } from "@/lib/business/openHours";

/** Display labels never become persisted timezone identifiers. */
export function timezoneOptions(locale: string, current = ""): { value: string; label: string }[] {
  const values = new Set(["UTC", ...Intl.supportedValuesOf("timeZone"), ...(current ? [current] : [])]);
  return [...values].map((value) => {
    const city = value.split("/").at(-1)?.replaceAll("_", " ") ?? value;
    let zoneName = value === "UTC" ? "UTC" : value.split("/")[0];
    try {
      const parts = new Intl.DateTimeFormat(locale, { timeZone: value, timeZoneName: "longGeneric" }).formatToParts(new Date());
      zoneName = parts.find((part) => part.type === "timeZoneName")?.value ?? zoneName;
    } catch { /* A stale saved timezone remains visible and fails validation on save. */ }
    return { value, label: value === "UTC" ? "UTC" : zoneName + " – " + city };
  }).sort((a, b) => a.label.localeCompare(b.label, locale));
}

const ISO_COUNTRIES = `
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ
EC EE EG EH ER ES ET
FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU
ID IE IL IM IN IO IQ IR IS IT
JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ
LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ
OM
PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA
RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ
VA VC VE VG VI VN VU
WF WS
YE YT
ZA ZM ZW
`.trim().split(/\s+/);

export function countryOptions(locale: string): { value: string; label: string }[] {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  return ISO_COUNTRIES.map((value) => ({ value, label: names.of(value) ?? value }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}

export function currencyOptions(locale: string, current = ""): { value: string; label: string }[] {
  const names = new Intl.DisplayNames([locale], { type: "currency" });
  return [...new Set([...Intl.supportedValuesOf("currency"), ...(current ? [current] : [])])]
    .map((value) => ({ value, label: value + " — " + (names.of(value) ?? value) }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}

export const US_STATES = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"],
  ["CA", "California"], ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"],
  ["DC", "District of Columbia"], ["FL", "Florida"], ["GA", "Georgia"], ["HI", "Hawaii"],
  ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"],
  ["MS", "Mississippi"], ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"],
  ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"], ["NM", "New Mexico"],
  ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"],
  ["UT", "Utah"], ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"],
  ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
  ["AS", "American Samoa"], ["GU", "Guam"], ["MP", "Northern Mariana Islands"],
  ["PR", "Puerto Rico"], ["VI", "U.S. Virgin Islands"],
] as const;

/** State codes and legacy saved English names remain stable; display names live in locale catalogs. */
export function usStateOptions(translations: Record<string, string>): { value: string; label: string; legacyName: string }[] {
  return US_STATES.map(([value, legacyName]) => ({
    value, legacyName, label: translations[value],
  }));
}

/** Grouped ISO 4217 defaults for common territories and countries; unmapped countries keep USD. */
const COUNTRY_CURRENCIES: Record<string, string> = Object.fromEntries(
  Object.entries({
    USD: "US AS GU MP PR VI EC SV PA TL FM MH PW TC VG", EUR: "AD AT AX BE BL CY DE EE ES FI FR GF GP GR IE IT LT LU LV MC ME MF MQ MT NL PM PT RE SI SK SM VA YT",
    GBP: "GB GG IM JE", CAD: "CA", AUD: "AU CX CC HM KI NR NF TV", NZD: "NZ CK NU PN TK",
    AED: "AE", AFN: "AF", ALL: "AL", AMD: "AM", AOA: "AO", ARS: "AR", AWG: "AW", AZN: "AZ",
    BAM: "BA", BBD: "BB", BDT: "BD", BGN: "BG", BHD: "BH", BIF: "BI", BMD: "BM", BND: "BN",
    BOB: "BO", BRL: "BR", BSD: "BS", BTN: "BT", BWP: "BW", BYN: "BY", BZD: "BZ",
    CHF: "CH LI", CLP: "CL", CNY: "CN", COP: "CO", CRC: "CR", CUP: "CU", CVE: "CV", CZK: "CZ",
    DKK: "DK FO GL", DJF: "DJ", DOP: "DO", DZD: "DZ", EGP: "EG", ERN: "ER", ETB: "ET",
    FJD: "FJ", FKP: "FK", GEL: "GE", GHS: "GH", GIP: "GI", GMD: "GM", GNF: "GN", GTQ: "GT", GYD: "GY",
    HKD: "HK", HNL: "HN", HTG: "HT", HUF: "HU", IDR: "ID", ILS: "IL PS", INR: "IN", IQD: "IQ", IRR: "IR", ISK: "IS",
    JMD: "JM", JOD: "JO", JPY: "JP", KES: "KE", KGS: "KG", KHR: "KH", KMF: "KM", KPW: "KP", KRW: "KR",
    KWD: "KW", KYD: "KY", KZT: "KZ", LAK: "LA", LBP: "LB", LKR: "LK", LRD: "LR", LSL: "LS", LYD: "LY",
    MAD: "MA EH", MDL: "MD", MGA: "MG", MKD: "MK", MMK: "MM", MNT: "MN", MOP: "MO",
    MRU: "MR", MUR: "MU", MVR: "MV", MWK: "MW", MXN: "MX", MYR: "MY", MZN: "MZ",
    NAD: "NA", NGN: "NG", NIO: "NI", NOK: "NO SJ BV", NPR: "NP", OMR: "OM", PEN: "PE",
    PGK: "PG", PHP: "PH", PKR: "PK", PLN: "PL", PYG: "PY", QAR: "QA", RON: "RO", RSD: "RS", RUB: "RU", RWF: "RW",
    SAR: "SA", SBD: "SB", SCR: "SC", SDG: "SD", SEK: "SE", SGD: "SG", SHP: "SH", SLE: "SL",
    SOS: "SO", SRD: "SR", SSP: "SS", STN: "ST", SYP: "SY", SZL: "SZ", THB: "TH", TJS: "TJ", TMT: "TM",
    TND: "TN", TOP: "TO", TRY: "TR", TTD: "TT", TWD: "TW", TZS: "TZ", UAH: "UA", UGX: "UG",
    UYU: "UY", UZS: "UZ", VES: "VE", VND: "VN", VUV: "VU", WST: "WS", XAF: "CM CF CG GA GQ TD",
    XCD: "AG AI DM GD KN LC MS VC", XOF: "BJ BF CI GW ML NE SN TG", XPF: "NC PF WF",
    YER: "YE", ZAR: "ZA", ZMW: "ZM", ZWG: "ZW",
  }).flatMap(([currency, countries]) => countries.split(" ").map((country) => [country, currency])),
);

export function currencyForCountry(code: string): string {
  return COUNTRY_CURRENCIES[code.toUpperCase()] ?? "USD";
}

export function copyMondayToWeekdays(hours: WeeklyHoursInput): WeeklyHoursInput {
  const monday = hours.mon;
  return {
    ...hours,
    tue: { ...monday },
    wed: { ...monday },
    thu: { ...monday },
    fri: { ...monday },
  };
}

/** Keyboard navigation starts at the first/last result and never references a missing option. */
export function moveTimezoneActiveIndex(current: number, direction: -1 | 1, count: number): number {
  if (count === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, current + direction));
}

/** Keep the virtual-focus option inside the popup viewport without scrolling the page. */
export function timezoneOptionScrollTop(
  scrollTop: number, viewportHeight: number, optionTop: number, optionHeight: number,
): number {
  if (optionTop < scrollTop) return optionTop;
  const optionBottom = optionTop + optionHeight;
  return optionBottom > scrollTop + viewportHeight ? optionBottom - viewportHeight : scrollTop;
}

export function shouldFocusHours(focus: string | string[] | undefined): boolean {
  return focus === "hours";
}

export type ProfileValuesToValidate = {
  name: string;
  timezone: string;
  currency: string;
  countryCode: string;
  openedOn: string;
  hours: WeeklyHoursInput;
};

/** Reject normalized dates such as February 30 that Date.parse otherwise accepts. */
function isValidCalendarDate(value: string): boolean {
  const parsed = new Date(value + "T12:00:00Z");
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateProfile(values: ProfileValuesToValidate, messages: {
  name: string; timezone: string; currency: string; country: string; openedOn: string; hours: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!values.name.trim() || values.name.length > 80) errors.name = messages.name;
  try {
    if (!values.timezone || !new Intl.DateTimeFormat("en-US", { timeZone: values.timezone }).resolvedOptions().timeZone) {
      errors.timezone = messages.timezone;
    }
  } catch { errors.timezone = messages.timezone; }
  if (!/^[A-Z]{3}$/.test(values.currency) || !Intl.supportedValuesOf("currency").includes(values.currency)) errors.currency = messages.currency;
  if (values.countryCode && (!/^[A-Z]{2}$/.test(values.countryCode) || !ISO_COUNTRIES.includes(values.countryCode))) errors.countryCode = messages.country;
  if (values.openedOn && (!/^\d{4}-\d{2}-\d{2}$/.test(values.openedOn) || !isValidCalendarDate(values.openedOn))) errors.openedOn = messages.openedOn;
  for (const [key, day] of Object.entries(values.hours)) {
    if (day.mode === "open" && (!isValidLocalTime(day.open) || !isValidLocalTime(day.close) || day.open === day.close)) errors["hours-" + key] = messages.hours;
  }
  return errors;
}
