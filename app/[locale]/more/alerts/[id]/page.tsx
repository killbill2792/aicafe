import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import BackHeader from "@/components/shared/BackHeader";
import Money from "@/components/shared/Money";
import PlainIcon from "@/components/icons/PlainIcon";
import { describeAlert } from "@/components/alerts/alertContent";
import { markAlertStatus, setAlertStatus } from "@/lib/actions/alerts";
import { getAlertById } from "@/lib/data/getAlerts";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";
import PageShell from "@/components/shared/PageShell";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { formatShiftTime } from "@/lib/alerts/shiftTime";

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

  if (alert.status === "new") {
    await setAlertStatus(alert.id, "seen");
  }

  return (
    <PageShell className="flex flex-col gap-4 px-4 py-6 pb-10">
      <BackHeader title={content.title} backHref="/more/alerts" backLabel={tCommon("back")} />

      <section className="flex flex-col items-center gap-3 rounded-card-lg bg-card p-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-warn-tint text-warn">
          <PlainIcon code={content.icon as ExpenseIconCode} size={26} color="#B4460E" />
        </span>
        {alert.impactCents !== null && (
          <><span className="text-sm font-bold text-warn">{t("potentialImpact")}</span><span className="font-headline text-[44px] font-bold leading-none text-warn"><Money cents={alert.impactCents} /></span></>
        )}
        <p className="text-base leading-snug text-ink">{content.subtitle}</p>
      </section>

      {alert.kind === "meal_break" && <section className="flex flex-col gap-2 rounded-card-lg bg-card p-[18px]">
        <h2 className="text-lg font-bold">{t("shiftDetails")}</h2>
        <Detail label={t("employee")} value={String(alert.payload.employeeName ?? t("someone"))} />
        <Detail label={t("shiftDate")} value={String(alert.payload.date ?? "—")} />
        <Detail label={t("clockIn")} value={formatShiftTime(alert.payload.clockIn, snapshot.business.timezone, locale)} />
        <Detail label={alert.payload.clockOut ? t("clockOut") : t("currentElapsed")} value={alert.payload.clockOut ? formatShiftTime(alert.payload.clockOut, snapshot.business.timezone, locale) : t("hoursElapsed", { hours: Number(alert.payload.shiftHours ?? 0).toFixed(1) })} />
        <Detail label={t("recordedBreak")} value={qualifyingBreakText(alert.payload.breaks, t("noQualifyingBreak"), snapshot.business.timezone, locale)} />
        <p className="mt-2 rounded-xl bg-warn-tint p-3 text-[15px] text-[#6E2A07]">{t("mealBreakExactReason")}</p>
        <p className="text-sm text-ink-muted">{t("mealBreakImpactBasis")}</p>
      </section>}

      <div className="rounded-2xl bg-warn-tint p-4 text-sm leading-snug text-[#6E2A07]">{t("neverAccusatoryNote")}</div>

      <a href={content.actionHref} className="flex h-14 items-center justify-center rounded-full bg-ink text-lg font-bold text-paper">
        {content.actionLabel}
      </a>

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
