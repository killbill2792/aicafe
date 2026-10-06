"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "@/i18n/navigation";
import { updateCafeProfile } from "@/lib/actions/business";
import { openHoursToWeeklyInput, type OpenHours, type OpenHoursDayKey, type WeeklyHoursInput } from "@/lib/business/openHours";

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
};

const DAY_ORDER: OpenHoursDayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export default function CafeProfileForm({ profile, labels }: { profile: Profile; labels: Labels }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(profile.name);
  const [locationName, setLocationName] = useState(profile.locationName);
  const [openedOn, setOpenedOn] = useState(profile.openedOn);
  const [timezone, setTimezone] = useState(profile.timezone);
  const [currency, setCurrency] = useState(profile.currency);
  const [addressLine1, setAddressLine1] = useState(profile.addressLine1);
  const [addressLine2, setAddressLine2] = useState(profile.addressLine2);
  const [city, setCity] = useState(profile.city);
  const [region, setRegion] = useState(profile.region);
  const [postalCode, setPostalCode] = useState(profile.postalCode);
  const [countryCode, setCountryCode] = useState(profile.countryCode);
  const [hours, setHours] = useState<WeeklyHoursInput>(() => openHoursToWeeklyInput(profile.openHours));

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
    setStatus("idle");
    setError(null);
    startTransition(async () => {
      const result = await updateCafeProfile({
        name,
        locationName,
        openedOn,
        timezone,
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
      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
        <h2 className="text-lg font-bold text-ink">{labels.businessDetails}</h2>
        <Field label={labels.cafeName}>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className="min-h-12 rounded-xl border border-line px-3 text-base" />
        </Field>
        <Field label={labels.locationName}>
          <input value={locationName} onChange={(e) => setLocationName(e.target.value)} maxLength={80} className="min-h-12 rounded-xl border border-line px-3 text-base" />
        </Field>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={labels.openedOn}>
            <input type="date" value={openedOn} onChange={(e) => setOpenedOn(e.target.value)} className="min-h-12 rounded-xl border border-line px-3 text-base" />
          </Field>
          <Field label={labels.currency}>
            <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} className="min-h-12 rounded-xl border border-line px-3 text-base uppercase" />
          </Field>
        </div>
        <Field label={labels.timezone} hint={labels.timezoneHint}>
          <input value={timezone} onChange={(e) => setTimezone(e.target.value)} maxLength={100} placeholder="America/Los_Angeles" className="min-h-12 rounded-xl border border-line px-3 text-base" />
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
            <input value={region} onChange={(e) => setRegion(e.target.value)} maxLength={80} className="min-h-12 rounded-xl border border-line px-3 text-base" />
          </Field>
          <Field label={labels.postalCode}>
            <input value={postalCode} onChange={(e) => setPostalCode(e.target.value)} maxLength={24} className="min-h-12 rounded-xl border border-line px-3 text-base" />
          </Field>
          <Field label={labels.countryCode}>
            <input value={countryCode} onChange={(e) => setCountryCode(e.target.value.toUpperCase())} maxLength={2} className="min-h-12 rounded-xl border border-line px-3 text-base uppercase" />
          </Field>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
        <div>
          <h2 className="text-lg font-bold text-ink">{labels.regularHours}</h2>
          <p className="mt-1 text-sm leading-snug text-ink-muted">{labels.regularHoursHint}</p>
        </div>
        <div className="flex flex-col gap-2">
          {DAY_ORDER.map((key) => {
            const day = hours[key];
            return (
              <div key={key} className="grid grid-cols-[4.5rem_1fr] gap-2 rounded-xl bg-paper p-3 sm:grid-cols-[5rem_8rem_1fr] sm:items-center">
                <span className="font-bold text-ink">{dayLabels[key]}</span>
                <select
                  value={day.mode}
                  onChange={(e) => changeMode(key, e.target.value as "unset" | "open" | "closed")}
                  className="min-h-11 rounded-lg border border-line bg-card px-2 text-sm"
                >
                  <option value="unset">{labels.notSet}</option>
                  <option value="open">{labels.open}</option>
                  <option value="closed">{labels.closed}</option>
                </select>
                {day.mode === "open" && (
                  <div className="col-span-2 flex min-w-0 items-center gap-2 sm:col-span-1">
                    <label className="flex min-w-0 flex-1 items-center gap-1 text-xs font-semibold text-ink-muted">
                      <span className="sr-only">{labels.opens}</span>
                      <input type="time" value={day.open} onChange={(e) => changeTime(key, "open", e.target.value)} className="min-h-11 min-w-0 w-full rounded-lg border border-line bg-card px-2 text-sm" />
                    </label>
                    <span className="text-ink-muted">–</span>
                    <label className="flex min-w-0 flex-1 items-center gap-1 text-xs font-semibold text-ink-muted">
                      <span className="sr-only">{labels.closes}</span>
                      <input type="time" value={day.close} onChange={(e) => changeTime(key, "close", e.target.value)} className="min-h-11 min-w-0 w-full rounded-lg border border-line bg-card px-2 text-sm" />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {error && <p className="rounded-xl bg-warn-tint p-3 text-sm font-semibold text-warn">{error}</p>}
      {status === "saved" && <p className="rounded-xl bg-good-tint p-3 text-sm font-semibold text-good">{labels.saved}</p>}
      <button type="button" onClick={save} disabled={isPending || !name.trim() || currency.trim().length !== 3} className="min-h-14 rounded-full bg-ink px-5 text-base font-bold text-paper disabled:opacity-40">
        {isPending ? labels.saving : labels.save}
      </button>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
      <span>{label}</span>
      {children}
      {hint && <span className="text-xs font-normal text-ink-muted">{hint}</span>}
    </label>
  );
}
