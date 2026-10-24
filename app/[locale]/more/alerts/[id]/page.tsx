import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import BackHeader from "@/components/shared/BackHeader";
import PlainIcon from "@/components/icons/PlainIcon";
import { describeAlert } from "@/components/alerts/alertContent";
import { markAlertStatus, setAlertStatus } from "@/lib/actions/alerts";
import { getAlertById } from "@/lib/data/getAlerts";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";
import PageShell from "@/components/shared/PageShell";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { formatShiftTime } from "@/lib/alerts/shiftTime";
import { formatCents } from "@/lib/calc/money";
import { Link } from "@/i18n/navigation";
import { formatInTimeZone } from "date-fns-tz";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function AlertDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwnBusiness();
  const { id } = await params;

  const [alert, snapshot, locale] = await Promise.all([getAlertById(id), getSnapshot(), getLocale()]);
  if (!alert) notFound();

  const t = await getTranslations("Alerts");
  const tCommon = await getTranslations("Common");
  const tCategories = await getTranslations("Categories");
  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<ExpenseCategoryCode, string>;
  const content = describeAlert(alert, t, (code) => categoryLabels[code as ExpenseCategoryCode] ?? code);
  const voids = alert.voidsReview ?? null;
  const displayedImpact = alert.kind === "voids" ? (voids?.ok ? voids.summary.thisMonthCents : null) : alert.impactCents;

  if (alert.status === "new") {
    await setAlertStatus(alert.id, "seen");
  }

  return (
    <PageShell className="flex flex-col gap-4 px-4 py-6 pb-10">
      <BackHeader title={content.title} backHref="/more/alerts" backLabel={tCommon("back")} />

      <section className="flex flex-col items-center gap-3 rounded-card-lg bg-card p-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-warn-tint text-warn">
          <PlainIcon code={content.icon as ExpenseIconCode} size={26} color="rgb(var(--c-warn-text))" />
        </span>
        {displayedImpact !== null && (
          <><span className="text-sm font-bold text-warn">{t("potentialImpact")}</span><span className="font-headline text-[44px] font-bold leading-none text-warn">{formatCents(displayedImpact, locale)}</span></>
        )}
        <p className="text-base leading-snug text-ink">{content.subtitle}</p>
      </section>

      {alert.kind === "meal_break" && <section className="flex flex-col gap-2 rounded-card-lg bg-card p-[18px]">
        <h2 className="text-lg font-bold">{t("shiftDetails")}</h2>
        <Detail label={t("employee")} value={String(alert.payload.employeeName ?? t("someone"))} />
        <Detail label={t("shiftDate")} value={formatBusinessDate(alert.payload.date, locale)} />
        <Detail label={t("clockIn")} value={formatShiftTime(alert.payload.clockIn, snapshot.business.timezone, locale)} />
        <Detail label={alert.payload.clockOut ? t("clockOut") : t("currentElapsed")} value={alert.payload.clockOut ? formatShiftTime(alert.payload.clockOut, snapshot.business.timezone, locale) : t("hoursElapsed", { hours: formatHours(alert.payload.shiftHours, locale) })} />
        <Detail label={t("recordedBreak")} value={qualifyingBreakText(alert.payload.breaks, t("noQualifyingBreak"), snapshot.business.timezone, locale)} />
        <p className="mt-2 rounded-xl bg-warn-tint p-3 text-[15px] text-warn-text">{t("mealBreakExactReason")}</p>
        <p className="text-sm text-ink-muted">{t("mealBreakImpactBasis")}</p>
      </section>}

      {alert.kind === "voids" && <section id="voids-review" className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <h2 className="text-lg font-bold">{t("voidsReviewTitle")}</h2>
        {voids?.ok ? <>
          <Detail
            label={voids.summary.monthKey === formatInTimeZone(new Date(), snapshot.business.timezone, "yyyy-MM")
              ? t("voidsThisMonth")
              : t("voidsAlertMonth", { month: formatBusinessMonth(voids.summary.monthKey, locale) })}
            value={voids.summary.thisMonthCents === null ? t("voidsUnknown") : formatCents(voids.summary.thisMonthCents, locale)}
          />
          <Detail label={t("voidsAverage")} value={voids.summary.previousThreeMonthAverageCents === null
            ? t("voidsUnknown") : formatCents(voids.summary.previousThreeMonthAverageCents, locale)} />
          {voids.summary.previousThreeMonthAverageCents === null && <p className="text-sm text-ink-muted">{t("voidsMissingHistory")}</p>}
          <h3 className="font-semibold">{t("voidsByDay")}</h3>
          {voids.summary.days.length === 0 ? <p className="text-sm text-ink-muted">{t("voidsNoData")}</p> :
            <div className="flex flex-col gap-2">{voids.summary.days.map((day) =>
              <Detail key={day.date} label={formatBusinessDate(day.date, locale)} value={formatCents(day.cents, locale)} />
            )}</div>}
          <p className="text-sm text-ink-muted">{t("voidsCoverageNote")}</p>
          <p className="text-sm text-ink-muted">{t("voidsPeopleUnavailable")}</p>
        </> : <p className="text-sm text-ink-muted">{t("voidsReadError")}</p>}
      </section>}

      <div className="rounded-2xl bg-warn-tint p-4 text-sm leading-snug text-warn-text">{t("neverAccusatoryNote")}</div>

      {content.actionHref !== `/more/alerts/${encodeURIComponent(alert.id)}` && (
        <Link href={content.actionHref} className="flex h-14 items-center justify-center rounded-full bg-accent text-lg font-bold text-on-accent">
          {content.actionLabel}
        </Link>
      )}

      <form action={markAlertStatus.bind(null, alert.id, "resolved")}>
        <button type="submit" className="flex h-[52px] w-full items-center justify-center rounded-full border border-line text-base font-semibold text-ink">
          {t("markReviewed")}
        </button>
      </form>
      <form action={markAlertStatus.bind(null, alert.id, "dismissed")}>
        <button type="submit" className="flex h-11 w-full items-center justify-center text-sm font-semibold text-ink-muted">
          {t("dismiss")}
        </button>
      </form>
    </PageShell>
  );
}

function Detail({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-3 text-[17px]"><span className="text-ink-muted">{label}</span><strong className="text-end">{value}</strong></div>; }
function qualifyingBreakText(value: unknown, fallback: string, timezone: string, locale: string) { if (!Array.isArray(value)) return fallback; const found = value.find((entry) => entry && typeof entry === "object" && "start" in entry && "end" in entry && (new Date(String(entry.end)).getTime() - new Date(String(entry.start)).getTime()) >= 30 * 60_000); return found ? `${formatShiftTime(found.start, timezone, locale)}–${formatShiftTime(found.end, timezone, locale)}` : fallback; }

function formatBusinessDate(value: unknown, locale: string): string {
  const day = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "—";
  const date = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) return "—";
  return new Intl.DateTimeFormat(locale, { year:"numeric", month:"short", day:"numeric", timeZone:"UTC" }).format(date);
}
function formatBusinessMonth(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { year:"numeric", month:"long", timeZone:"UTC" }).format(new Date(`${value}-01T12:00:00Z`));
}
function formatHours(value: unknown, locale: string): string {
  if (value === null || value === undefined || value === "") return "—";
  const hours = Number(value);
  return Number.isFinite(hours) && hours >= 0
    ? new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(hours)
    : "—";
}
