"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { saveStaffAvailabilityBatch } from "@/lib/actions/schedulingFoundation";

export type SchedulingRow = Record<string, unknown> & { id: string; revision: number };
export type SchedulingLocation = { id: string; name: string; timezone: string | null };

type DraftWindow = {
  id?: string;
  day_of_week: number;
  start_local: string;
  end_local: string;
  overnight: boolean;
  source: "owner_direct" | "worker_reported_by_owner";
  confirmation: "owner_confirmed" | "unconfirmed";
};

const week = [1, 2, 3, 4, 5, 6, 0];
const field = "min-h-12 rounded-xl border border-line bg-white px-3 text-base text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
export const schedulingFieldClass = field;
export const schedulingButtonClass = "min-h-12 rounded-xl border border-line bg-card px-3 text-base font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
export const schedulingPrimaryClass = "min-h-12 rounded-xl bg-ink px-4 text-base font-semibold text-paper disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

function windowFromRecord(row: SchedulingRow): DraftWindow {
  return {
    id: row.id, day_of_week: Number(row.day_of_week),
    start_local: String(row.start_local), end_local: String(row.end_local),
    overnight: row.overnight === true,
    source: row.source === "worker_reported_by_owner" ? "worker_reported_by_owner" : "owner_direct",
    confirmation: row.confirmation === "owner_confirmed" ? "owner_confirmed" : "unconfirmed",
  };
}

export default function AvailabilityEditor({ employeeId, rows, preferences, locations, today }: {
  employeeId: string; rows: SchedulingRow[]; preferences: SchedulingRow[];
  locations: SchedulingLocation[]; today: string;
}) {
  const t = useTranslations("SchedulingAvailability");
  const router = useRouter();
  const effectiveScopes = [...new Set(rows.filter((r) => r.employee_id === employeeId)
    .map((r) => String(r.effective_from)))].sort().reverse();
  const [effectiveFrom, setEffectiveFrom] = useState(effectiveScopes[0] ?? today);
  const [effectiveTo, setEffectiveTo] = useState("");
  const [locationId, setLocationId] = useState("");
  const [draftOverride, setDraftOverride] = useState<DraftWindow[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const requestKey = useRef<string | null>(null);

  const scoped = useMemo(() => rows.filter((row) =>
    row.employee_id === employeeId &&
    (row.location_id ?? null) === (locationId || null) &&
    row.effective_from === effectiveFrom &&
    (row.effective_to ?? null) === (effectiveTo || null)
  ), [rows, employeeId, locationId, effectiveFrom, effectiveTo]);

  const draft = draftOverride ?? scoped.map(windowFromRecord);

  function change(updater: (previous: DraftWindow[]) => DraftWindow[]) {
    setDraftOverride((previous) => updater(previous ?? scoped.map(windowFromRecord))); setDirty(true); setSaved(false); setError(null);
    requestKey.current = null;
  }
  function switchScope(setter: (value: string) => void, value: string) {
    if (dirty && !window.confirm(t("discardEdits"))) return;
    setDraftOverride(null); setDirty(false); setError(null); setSaved(false);
    requestKey.current = null; setter(value);
  }
  function save() {
    if (scoped.some((row) => !draft.some((d) => d.id===row.id)) &&
        !window.confirm(t("confirmRemove"))) return;
    if (!effectiveFrom || (effectiveTo && effectiveTo < effectiveFrom)) {
      setError(t("checkDates")); return;
    }
    const expected = scoped.map((row) => ({ id: row.id, revision: row.revision }));
    const desired = draft.map((row) => ({
      ...(row.id ? { id: row.id } : {}),
      data: {
        employee_id: employeeId, location_id: locationId || null,
        day_of_week: row.day_of_week, start_local: row.start_local,
        end_local: row.end_local, overnight: row.overnight,
        effective_from: effectiveFrom, effective_to: effectiveTo || null,
        source: row.source, confirmation: row.confirmation,
      },
    }));
    requestKey.current ??= crypto.randomUUID();
    startTransition(async () => {
      const result = await saveStaffAvailabilityBatch({
        kind: "availability_rule", employeeId, locationId: locationId || null,
        scope: { effective_from: effectiveFrom, effective_to: effectiveTo || null },
        expected, desired, requestKey: requestKey.current,
      });
      if (!result.ok) {
        setError(result.error === "conflict" ? t("conflict") : t("saveFailed"));
        return;
      }
      requestKey.current = null; setDraftOverride(null); setDirty(false); setSaved(true);
      router.refresh();
    });
  }
  const confirmedUnavailableDays = new Set(
    preferences.filter(p => p.employee_id===employeeId &&
        p.confirmation==="owner_confirmed" &&
        String(p.effective_from)<=effectiveFrom &&
        (p.effective_to == null || String(p.effective_to)>=effectiveFrom))
      .flatMap(p=>Array.isArray(p.unavailable_weekdays)
        ? (p.unavailable_weekdays as number[]) : []));
  const dayNames = [t("sun"), t("mon"), t("tue"), t("wed"), t("thu"), t("fri"), t("sat")];

  return (
    <section aria-label={t("weeklyAvailability")} className="flex flex-col gap-3 rounded-xl bg-white p-3">
      <h4 className="text-base font-bold">{t("weeklyAvailability")}</h4>
      <p className="text-sm text-ink-muted">{t("availabilityExplainer")}</p>
      <label className="flex flex-col gap-1 text-sm font-semibold">{t("location")}
        <select className={field} value={locationId}
          onChange={(e) => switchScope(setLocationId, e.target.value)}>
          <option value="">{t("allLocations")}</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-semibold">{t("effectiveFrom")}
        <input className={field} type="date" value={effectiveFrom}
          onChange={(e) => switchScope(setEffectiveFrom, e.target.value)}/>
      </label>
      {effectiveScopes.length > 0 && <label className="flex flex-col gap-1 text-sm font-semibold">
        {t("existingPeriods")}
        <select className={field} value={effectiveScopes.includes(effectiveFrom) ? effectiveFrom : ""}
          onChange={(e) => switchScope(setEffectiveFrom, e.target.value)}>
          <option value="">{t("newPeriod")}</option>
          {effectiveScopes.map((date) => <option key={date} value={date}>{date}</option>)}
        </select>
      </label>}
      <label className="flex flex-col gap-1 text-sm font-semibold">{t("effectiveTo")}
        <input className={field} type="date" value={effectiveTo}
          onChange={(e) => switchScope(setEffectiveTo, e.target.value)}/>
      </label>
      <div className="flex flex-col gap-3">
        {week.map((day) => {
          const windows = draft.map((row, index) => ({ row, index }))
            .filter(({ row }) => row.day_of_week === day)
            .sort((a,b) => a.row.start_local.localeCompare(b.row.start_local));
          return <div key={day} className="rounded-xl border border-line p-3">
            <div className="flex items-center justify-between gap-2">
              <h5 className="font-semibold">{dayNames[day]}</h5>
              <button type="button" className={schedulingButtonClass}
                onClick={() => change((all) => [...all, {
                  day_of_week: day, start_local: "09:00", end_local: "17:00",
                  overnight: false, source: "owner_direct", confirmation: "unconfirmed",
                }])}>{t("addWindow")}</button>
            </div>
            {windows.length === 0 && <p className="py-2 text-sm text-ink-muted">
              {confirmedUnavailableDays.has(day) ? t("confirmedUnavailableDay") : t("notRecorded")}
            </p>}
            {windows.map(({ row, index }) => (
              <div key={row.id ?? `new-${index}`} className="mt-2 flex flex-col gap-2 rounded-xl bg-paper p-3">
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-sm">{t("start")}
                    <input type="time" className={field} value={row.start_local}
                      onChange={(e) => change((all) => all.map((item, i) =>
                        i===index ? {...item, start_local:e.target.value} : item))}/>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">{t("end")}
                    <input type="time" className={field} value={row.end_local}
                      onChange={(e) => change((all) => all.map((item, i) =>
                        i===index ? {...item, end_local:e.target.value} : item))}/>
                  </label>
                </div>
                <label className="flex min-h-12 items-center gap-2 text-sm">
                  <input type="checkbox" checked={row.overnight}
                    onChange={(e) => change((all) => all.map((item, i) =>
                      i===index ? {...item, overnight:e.target.checked} : item))}/>
                  {t("overnight")}
                </label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">{t("source")}
                    <select className={field} value={row.source}
                      onChange={(e) => change((all) => all.map((item,i) => i===index ?
                        {...item, source:e.target.value as DraftWindow["source"]} : item))}>
                      <option value="owner_direct">{t("ownerDirect")}</option>
                      <option value="worker_reported_by_owner">{t("workerReported")}</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-sm">{t("confirmation")}
                    <select className={field} value={row.confirmation}
                      onChange={(e) => change((all) => all.map((item,i) => i===index ?
                        {...item, confirmation:e.target.value as DraftWindow["confirmation"]} : item))}>
                      <option value="unconfirmed">{t("unconfirmed")}</option>
                      <option value="owner_confirmed">{t("ownerConfirmed")}</option>
                    </select>
                  </label>
                </div>
                <button type="button" className={schedulingButtonClass}
                  onClick={() => change((all) => all.filter((_, i) => i!==index))}>{t("remove")}</button>
              </div>
            ))}
          </div>;
        })}
      </div>
      <p className="text-sm text-ink-muted">{t("doesNotAssign")}</p>
      {error && <p role="alert" className="text-sm font-semibold text-warn">{error}</p>}
      {saved && <p role="status" className="text-sm text-good">{t("saved")}</p>}
      {dirty && <p role="status" className="text-sm text-warn">{t("unsaved")}</p>}
      <button type="button" className={schedulingPrimaryClass} disabled={pending || !dirty} onClick={save}>
        {pending ? t("saving") : t("saveAvailability")}
      </button>
    </section>
  );
}
