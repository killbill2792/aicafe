"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { useLocale } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { updateCafeProfile } from "@/lib/actions/business";
import { openHoursToWeeklyInput, type OpenHours, type OpenHoursDayKey, type WeeklyHoursInput } from "@/lib/business/openHours";
import { copyMondayToWeekdays, countryOptions, currencyForCountry, currencyOptions, shouldFocusHours, timezoneOptions, usStateOptions, validateProfile } from "./cafeProfileOptions";

type Profile = {
  name: string;
  timezone: string;
  currency: string;
  openedOn: string;
  locationName: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  openHours: OpenHours | null;
};

type Labels = {
  businessDetails: string;
  cafeName: string;
  locationName: string;
  openedOn: string;
  timezone: string;
  timezoneHint: string;
  currency: string;
  address: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  regularHours: string;
  regularHoursHint: string;
  dayMon: string;
  dayTue: string;
  dayWed: string;
  dayThu: string;
  dayFri: string;
  daySat: string;
  daySun: string;
  notSet: string;
  open: string;
  closed: string;
  opens: string;
  closes: string;
  save: string;
  saving: string;
  saved: string;
  locationOptional: string;
  hoursBadge: string;
  copyWeekdays: string;
  timezoneSearch: string;
  timezoneEmpty: string;
  chooseCountry: string;
  chooseCurrency: string;
  chooseState: string;
  invalidName: string;
  invalidTimezone: string;
  invalidCurrency: string;
  invalidCountry: string;
  invalidDate: string;
  invalidHours: string;
  invalidSummary: string;
};

const DAY_ORDER: OpenHoursDayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const noTimezoneEvents = () => () => {};
const serverTimezone = () => "";
function getBrowserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; }
  catch { return ""; }
}

export default function CafeProfileForm({ profile, labels, focusHours = false }: { profile: Profile; labels: Labels; focusHours?: boolean }) {
  const locale = useLocale();
  const browserTimezone = useSyncExternalStore(noTimezoneEvents, getBrowserTimezone, serverTimezone);
  const fieldRefs = useRef<Record<string, HTMLInputElement | HTMLSelectElement | null>>({});
  const hoursRef = useRef<HTMLElement | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const invalidClass = (key: string) => fieldErrors[key] ? " !border-red-600 ring-1 ring-red-600" : "";
  const clearFieldError = (key: string) => setFieldErrors((errors) => {
    if (!errors[key]) return errors;
    const next = { ...errors };
    delete next[key];
    return next;
  });
  const timezones = useMemo(() => timezoneOptions(locale, profile.timezone), [locale, profile.timezone]);
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const usStates = useMemo(() => usStateOptions(locale), [locale]);
  const currencies = useMemo(() => currencyOptions(locale, profile.currency), [locale, profile.currency]);
  const [timezoneSearch, setTimezoneSearch] = useState(() =>
    timezoneOptions(locale, profile.timezone).find((option) => option.value === profile.timezone)?.label ?? profile.timezone);
  const [timezoneExpanded, setTimezoneExpanded] = useState(false);
  const [timezoneActive, setTimezoneActive] = useState(0);
  const timezoneResults = useMemo(() => {
    const query = timezoneSearch.trim().toLocaleLowerCase(locale);
    return timezones.filter((option) => !query || option.label.toLocaleLowerCase(locale).includes(query) || option.value.toLowerCase().includes(query)).slice(0, 40);
  }, [timezones, timezoneSearch, locale]);
  const chooseTimezone = (value: string) => {
    setTimezone(value);
    setTimezoneTouched(true);
    setTimezoneSearch(timezones.find((option) => option.value === value)?.label ?? value);
    setTimezoneExpanded(false);
    clearFieldError("timezone");
  };

  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(profile.name);
  const [locationName, setLocationName] = useState(profile.locationName);
  const [openedOn, setOpenedOn] = useState(profile.openedOn);
  const [timezone, setTimezone] = useState(profile.timezone);
  const [timezoneTouched, setTimezoneTouched] = useState(false);
  const selectedTimezone = timezone || (!timezoneTouched && !profile.timezone ? browserTimezone : "");
  const shownTimezoneSearch = timezoneSearch || (!timezoneTouched && !profile.timezone
    ? (timezones.find((option) => option.value === browserTimezone)?.label ?? browserTimezone)
    : "");
  const [currency, setCurrency] = useState(profile.currency || currencyForCountry(profile.countryCode));
  const [addressLine1, setAddressLine1] = useState(profile.addressLine1);
  const [addressLine2, setAddressLine2] = useState(profile.addressLine2);
  const [city, setCity] = useState(profile.city);
  const [region, setRegion] = useState(profile.region);
  const [postalCode, setPostalCode] = useState(profile.postalCode);
  const [countryCode, setCountryCode] = useState(profile.countryCode);
  const [hours, setHours] = useState<WeeklyHoursInput>(() => openHoursToWeeklyInput(profile.openHours));
  const hoursNotSet = DAY_ORDER.some((key) => hours[key].mode === "unset");

  useEffect(() => {
    if (!shouldFocusHours(focusHours ? "hours" : undefined)) return;
    const node = hoursRef.current;
    if (!node) return;
    node.scrollIntoView({ block: "start" });
    node.focus({ preventScroll: true });
  }, [focusHours]);

  const changeCountry = (next: string) => {
    setCountryCode(next);
    if (!currency || currency === currencyForCountry(countryCode)) setCurrency(currencyForCountry(next));
    clearFieldError("countryCode");
  };

  const dayLabels: Record<OpenHoursDayKey, string> = {
    mon: labels.dayMon,
    tue: labels.dayTue,
    wed: labels.dayWed,
    thu: labels.dayThu,
    fri: labels.dayFri,
    sat: labels.daySat,
    sun: labels.daySun,
  };

  function changeMode(key: OpenHoursDayKey, mode: "unset" | "open" | "closed") {
    setHours((current) => ({
      ...current,
      [key]:
        mode === "open"
          ? current[key].mode === "open"
            ? current[key]
            : { mode: "open", open: "08:00", close: "17:00" }
          : { mode },
    }));
  }

  function changeTime(key: OpenHoursDayKey, field: "open" | "close", value: string) {
    setHours((current) => {
      const day = current[key];
      if (day.mode !== "open") return current;
      return { ...current, [key]: { ...day, [field]: value } };
    });
  }

  function save() {
    const errors = validateProfile({ name, timezone: selectedTimezone, currency, countryCode, openedOn, hours }, {
      name: labels.invalidName, timezone: labels.invalidTimezone,
      currency: labels.invalidCurrency, country: labels.invalidCountry,
      openedOn: labels.invalidDate, hours: labels.invalidHours,
    });
    setFieldErrors(errors);
    const firstError = Object.keys(errors)[0];
    if (firstError) {
      setStatus("error");
      setError(labels.invalidSummary);
      if (firstError.startsWith("hours-")) {
        hoursRef.current?.scrollIntoView({ block: "start" });
      }
      requestAnimationFrame(() => fieldRefs.current[firstError]?.focus());
      return;
    }
    setStatus("idle");
    setError(null);
    startTransition(async () => {
      const result = await updateCafeProfile({
        name,
        locationName,
        openedOn,
        timezone: selectedTimezone,
        currency: currency.toUpperCase(),
        addressLine1,
        addressLine2,
        city,
        region,
        postalCode,
        countryCode: countryCode.toUpperCase(),
        hours,
      });
      if (result.ok) {
        setStatus("saved");
        router.refresh();
      } else {
        setStatus("error");
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {hoursNotSet && (
        <div role="status" className="self-start rounded-full bg-warn-tint px-3 py-1.5 text-xs font-bold text-warn">{labels.hoursBadge}</div>
      )}
      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
        <h2 className="text-lg font-bold text-ink">{labels.businessDetails}</h2>
        <Field label={labels.cafeName} error={fieldErrors.name}>
          <input value={name} ref={(node) => { fieldRefs.current.name = node; }} aria-invalid={Boolean(fieldErrors.name)} onChange={(e) => { setName(e.target.value); clearFieldError("name"); }} maxLength={80} className={"min-h-12 rounded-xl border border-line px-3 text-base" + invalidClass("name")} />
        </Field>
        <Field label={labels.locationName}>
          <input value={locationName} onChange={(e) => setLocationName(e.target.value)} maxLength={80} className="min-h-12 rounded-xl border border-line px-3 text-base" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={labels.openedOn} error={fieldErrors.openedOn}>
            <input type="date" value={openedOn} ref={(node) => { fieldRefs.current.openedOn = node; }} aria-invalid={Boolean(fieldErrors.openedOn)} onChange={(e) => { setOpenedOn(e.target.value); clearFieldError("openedOn"); }} className={"min-h-12 rounded-xl border border-line px-3 text-base" + invalidClass("openedOn")} />
          </Field>
          <Field label={labels.currency} error={fieldErrors.currency}>
            <select value={currency} ref={(node) => { fieldRefs.current.currency = node; }} aria-invalid={Boolean(fieldErrors.currency)}
              onChange={(e) => { setCurrency(e.target.value); clearFieldError("currency"); }}
              className={"min-h-12 min-w-0 rounded-xl border border-line bg-card px-3 text-base" + invalidClass("currency")}>
              <option value="">{labels.chooseCurrency}</option>
              {currencies.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label={labels.timezone} hint={labels.timezoneHint} error={fieldErrors.timezone}>
          <div className="relative" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setTimezoneExpanded(false); }}>
            <input type="text" role="combobox" aria-autocomplete="list" aria-controls="cafe-timezone-options" aria-expanded={timezoneExpanded}
              aria-activedescendant={timezoneExpanded && timezoneResults[timezoneActive] ? "cafe-timezone-" + timezoneActive : undefined}
              aria-invalid={Boolean(fieldErrors.timezone)} ref={(node) => { fieldRefs.current.timezone = node; }}
              value={shownTimezoneSearch} placeholder={labels.timezoneSearch}
              onFocus={() => setTimezoneExpanded(true)}
              onChange={(e) => { setTimezoneTouched(true); setTimezoneSearch(e.target.value); setTimezone(""); setTimezoneExpanded(true); setTimezoneActive(0); clearFieldError("timezone"); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { setTimezoneExpanded(false); return; }
                if (e.key === "ArrowDown") { e.preventDefault(); setTimezoneExpanded(true); setTimezoneActive((index) => Math.min(index + 1, timezoneResults.length - 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setTimezoneActive((index) => Math.max(0, index - 1)); }
                if (e.key === "Enter" && timezoneExpanded && timezoneResults[timezoneActive]) { e.preventDefault(); chooseTimezone(timezoneResults[timezoneActive].value); }
              }}
              className={"min-h-12 w-full rounded-xl border border-line bg-card px-3 text-base text-start" + invalidClass("timezone")} />
            {timezoneExpanded && (
              <div id="cafe-timezone-options" role="listbox" className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-xl border border-line bg-card shadow-lg">
                {timezoneResults.length ? timezoneResults.map((option, index) => (
                  <button id={"cafe-timezone-" + index} key={option.value} type="button" role="option" aria-selected={selectedTimezone === option.value}
                    onMouseDown={(e) => e.preventDefault()} onClick={() => chooseTimezone(option.value)}
                    className={"block min-h-11 w-full px-3 py-2 text-start text-sm hover:bg-paper " + (index === timezoneActive ? "bg-paper font-semibold" : "")}>
                    {option.label}
                  </button>
                )) : <p className="p-3 text-sm text-ink-muted">{labels.timezoneEmpty}</p>}
              </div>
            )}
          </div>
        </Field>
      </section>

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
        <h2 className="text-lg font-bold text-ink">{labels.address}</h2>
        <Field label={labels.addressLine1}>
          <input value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} maxLength={120} className="min-h-12 rounded-xl border border-line px-3 text-base" />
        </Field>
        <Field label={labels.addressLine2}>
          <input value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} maxLength={120} className="min-h-12 rounded-xl border border-line px-3 text-base" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={labels.city}>
            <input value={city} onChange={(e) => setCity(e.target.value)} maxLength={80} className="min-h-12 rounded-xl border border-line px-3 text-base" />
          </Field>
          <Field label={labels.region}>
            {countryCode === "US" ? (
              <select value={region} onChange={(e) => setRegion(e.target.value)} className="min-h-12 rounded-xl border border-line bg-card px-3 text-base">
                <option value="">{labels.chooseState}</option>
                {region && !usStates.some((item) => region === item.value || region === item.legacyName) && <option value={region}>{region}</option>}
                {usStates.map((item) => (
                  <option key={item.value} value={region === item.legacyName ? region : item.value}>{item.label}</option>
                ))}
              </select>
            ) : <input value={region} onChange={(e) => setRegion(e.target.value)} maxLength={80} className="min-h-12 rounded-xl border border-line px-3 text-base" />}
          </Field>
          <Field label={labels.postalCode}>
            <input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} maxLength={24} className="min-h-12 rounded-xl border border-line px-3 text-base" />
          </Field>
          <Field label={labels.countryCode} error={fieldErrors.countryCode}>
            <select value={countryCode} ref={(node) => { fieldRefs.current.countryCode = node; }} aria-invalid={Boolean(fieldErrors.countryCode)}
              onChange={(e) => changeCountry(e.target.value)}
              className={"min-h-12 min-w-0 rounded-xl border border-line bg-card px-3 text-base" + invalidClass("countryCode")}>
              <option value="">{labels.chooseCountry}</option>
              {countryCode && !countries.some((item) => item.value === countryCode) && <option value={countryCode}>{countryCode}</option>}
              {countries.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </Field>
        </div>
      </section>

      <section id="cafe-hours" ref={hoursRef} tabIndex={-1} aria-labelledby="cafe-hours-heading" className="scroll-mt-24 flex flex-col gap-3 rounded-card-lg bg-card p-4 outline-none">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="cafe-hours-heading" className="text-lg font-bold text-ink">{labels.regularHours}</h2>
            <p className="mt-1 text-sm leading-snug text-ink-muted">{labels.regularHoursHint}</p>
          </div>
          {hoursNotSet && <span className="shrink-0 rounded-full bg-warn-tint px-2 py-1 text-xs font-bold text-warn">{labels.hoursBadge}</span>}
        </div>
        <button type="button" onClick={() => { setHours((current) => copyMondayToWeekdays(current)); setFieldErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !["hours-tue", "hours-wed", "hours-thu", "hours-fri"].includes(key)))); }}
          className="min-h-11 self-start rounded-full border border-line px-4 text-sm font-bold text-ink">{labels.copyWeekdays}</button>
        <div className="flex flex-col gap-2">
          {DAY_ORDER.map((key) => {
            const day = hours[key];
            return (
              <div key={key} className="grid grid-cols-[4.5rem_1fr] gap-2 rounded-xl bg-paper p-3 sm:grid-cols-[5rem_8rem_1fr] sm:items-center">
                <span className="font-bold text-ink">{dayLabels[key]}</span>
                <select
                  value={day.mode}
                  onChange={(e) => { changeMode(key, e.target.value as "unset" | "open" | "closed"); clearFieldError("hours-" + key); }}
                  className={"min-h-11 rounded-lg border border-line bg-card px-2 text-sm" + invalidClass("hours-" + key)}
                >
                  <option value="unset">{labels.notSet}</option>
                  <option value="open">{labels.open}</option>
                  <option value="closed">{labels.closed}</option>
                </select>
                {day.mode === "open" && (
                  <div className="col-span-2 flex min-w-0 items-center gap-2 sm:col-span-1">
                    <label className="flex min-w-0 flex-1 items-center gap-1 text-xs font-semibold text-ink-muted">
                      <span className="sr-only">{labels.opens}</span>
                      <input type="time" value={day.open} ref={(node) => { fieldRefs.current["hours-" + key] = node; }} aria-invalid={Boolean(fieldErrors["hours-" + key])}
                        onChange={(e) => { changeTime(key, "open", e.target.value); clearFieldError("hours-" + key); }}
                        className={"min-h-11 min-w-0 w-full rounded-lg border border-line bg-card px-2 text-sm" + invalidClass("hours-" + key)} />
                    </label>
                    <span className="text-ink-muted">–</span>
                    <label className="flex min-w-0 flex-1 items-center gap-1 text-xs font-semibold text-ink-muted">
                      <span className="sr-only">{labels.closes}</span>
                      <input type="time" value={day.close} aria-invalid={Boolean(fieldErrors["hours-" + key])}
                        onChange={(e) => { changeTime(key, "close", e.target.value); clearFieldError("hours-" + key); }}
                        className={"min-h-11 min-w-0 w-full rounded-lg border border-line bg-card px-2 text-sm" + invalidClass("hours-" + key)} />
                    </label>
                  </div>
                )}
                {fieldErrors["hours-" + key] && <p role="alert" className="col-span-2 text-xs font-normal text-red-700 sm:col-span-3">{fieldErrors["hours-" + key]}</p>}
              </div>
            );
          })}
        </div>
      </section>

      {error && <p role="alert" className="rounded-xl bg-warn-tint p-3 text-sm font-semibold text-warn">{error}</p>}
      {status === "saved" && <p className="rounded-xl bg-good-tint p-3 text-sm font-semibold text-good">{labels.saved}</p>}
      <div className="sticky bottom-20 z-20 -mx-4 border-t border-line bg-card/95 px-4 py-3 shadow-lg backdrop-blur md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:py-0 md:shadow-none">
        <button type="button" onClick={save} disabled={isPending} className="min-h-14 w-full rounded-full bg-accent px-5 text-base font-bold text-on-accent disabled:opacity-40">
          {isPending ? labels.saving : labels.save}
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
      <span>{label}</span>
      {children}
      {hint && <span className="text-xs font-normal text-ink-muted">{hint}</span>}
      {error && <span role="alert" className="text-xs font-normal text-red-700">{error}</span>}
    </label>
  );
}
