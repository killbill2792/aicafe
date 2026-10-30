"use client";

import { useEffect, useMemo, useState } from "react";
import { createTranslator } from "next-intl";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import { CalendarDays } from "lucide-react";
import type { EventsOutlook, OutlookDay } from "@/lib/events/outlook";

type Locale = "en" | "es" | "ar";
type Translate = (key: string, values?: Record<string, string | number>) => string;
export type ComingUpState = { status: "loading" } | { status: "error" } | { status: "ready"; outlook: EventsOutlook };

/** At most this many days on the board; the rest is one tap away in chat. */
export const COMING_UP_ROWS = 3;

function whenLabel(day: OutlookDay, locale: Locale, t: Translate): string {
  if (day.daysFromToday === 0) return t("today");
  if (day.daysFromToday === 1) return t("tomorrow");
  return new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(day.date + "T00:00:00Z"));
}

/** What is happening that day, in one short line. */
function whatLabel(day: OutlookDay, outlook: EventsOutlook, t: Translate): string {
  const names = [...day.holidays.map(h => h.name),
    ...day.eventIds.map(id => outlook.localEvents.find(e => e.id === id)?.name).filter((n): n is string => Boolean(n))];
  if (!names.length) return "";
  return names.length > 2 ? names.slice(0, 2).join(" · ") + " " + t("moreEvents", { count: names.length - 2 }) : names.join(" · ");
}

function basisLabel(day: OutlookDay, outlook: EventsOutlook, t: Translate, locale: Locale): string | null {
  if (day.lastTime) {
    const change = day.lastTime.changePercent;
    return t("basisSales", { change: (change > 0 ? "+" : "") + new Intl.NumberFormat(locale).format(change) });
  }
  const e = outlook.localEvents.find(x => day.eventIds.includes(x.id));
  return e ? t("basisEvent", { distance: e.distance ? " · " + e.distance : "" }) : null;
}

/** Pure view: the card for a loaded (or loading) outlook. */
export function ComingUpView({ state, locale, t, onAsk, disabled }:
  { state: ComingUpState; locale: Locale; t: Translate; onAsk: (prompt: string) => void; disabled: boolean }) {
  if (state.status === "error") return null; // never block Home; the chat can still answer
  const button = "inline-flex min-h-12 items-center text-[15px] font-semibold text-accent-text underline disabled:opacity-50";
  return <section className="min-w-0 rounded-2xl border border-line bg-card p-3" aria-label={t("title")} data-testid="coming-up">
    <h3 className="flex items-center gap-1.5 text-[15px] font-semibold text-ink-muted">
      <CalendarDays size={18} aria-hidden="true" />{t("title")}
    </h3>
    {state.status === "loading" ? <p className="mt-2 text-[15px] text-ink-muted" role="status">{t("loading")}</p> : (() => {
      const { outlook } = state;
      const rows = outlook.days.filter(d => d.holidays.length > 0 || d.eventIds.length > 0).slice(0, COMING_UP_ROWS);
      return <>
        {rows.length === 0 ? <p className="mt-2 text-[17px] text-ink">{t("nothingSpecial")}</p> :
          <ul className="mt-2 space-y-2">
            {rows.map(day => {
              const when = whenLabel(day, locale, t), what = whatLabel(day, outlook, t);
              const basis = basisLabel(day, outlook, t, locale);
              return <li key={day.date} className="min-w-0">
                <button type="button" disabled={disabled} onClick={() => onAsk(t("askDay", { what, when }))}
                  className="flex min-h-12 w-full min-w-0 items-start gap-2 rounded-xl bg-surface2 p-2.5 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-60">
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[15px] font-semibold leading-snug text-ink" dir="auto">{when} · {what}</span>
                    {basis && <span className="mt-0.5 block break-words text-[13px] leading-snug text-ink-muted" dir="auto">{basis}</span>}
                  </span>
                </button>
              </li>;
            })}
          </ul>}
        {outlook.addressMissing && <p className="mt-2 text-[15px] text-ink-muted">{t("addAddress")}{" "}
          <button type="button" disabled={disabled} className={button} onClick={() => onAsk(t("addressPrompt"))}>{t("addAddressButton")}</button>
        </p>}
        {outlook.notCovered.includes("localEventsSearchPartial") && <p className="mt-2 text-[13px] text-ink-muted" role="status">
          {t("searchPartial", {missed:outlook.localEventsSearchGaps?.map(g=>g.kind==="general"?
            t("searchGeneral"):g.name+" ("+g.date+")").join(", ")||t("searchOther")})}
        </p>}
        {outlook.notCovered.includes("localEventsSearchFailed") && <p className="mt-2 text-[13px] text-ink-muted">{t("searchDown")}</p>}
        {!outlook.addressMissing && <button type="button" disabled={disabled} className={button} onClick={() => onAsk(t("weekPrompt"))}>
          {t("askWeek")}
        </button>}
      </>;
    })()}
  </section>;
}

/** Loads after the page so a slow web search never delays Home. */
export default function ComingUpCard({ locale, onAsk, disabled }: { locale: Locale; onAsk: (prompt: string) => void; disabled: boolean }) {
  // Same message files the chat composer reads (it renders outside a provider in tests too).
  const t = useMemo(() => createTranslator({ locale, messages: { en, es, ar }[locale], namespace: "ComingUp" }) as unknown as Translate, [locale]);
  const [state, setState] = useState<ComingUpState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/events/outlook?locale=" + locale, { signal: controller.signal, cache: "no-store" })
      .then(async r => {
        const body = r.ok ? await r.json() as EventsOutlook : null;
        setState(body && Array.isArray(body.days) ? { status: "ready", outlook: body } : { status: "error" });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: "error" }); });
    return () => controller.abort();
  }, [locale]);
  return <ComingUpView state={state} locale={locale} t={t} onAsk={onAsk} disabled={disabled} />;
}
