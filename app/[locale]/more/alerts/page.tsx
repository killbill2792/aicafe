import { getLocale, getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getOpenAlerts } from "@/lib/data/getAlerts";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import BackHeader from "@/components/shared/BackHeader";
import AlertCard from "@/components/alerts/AlertCard";
import { describeAlert } from "@/components/alerts/alertContent";
import { formatCents } from "@/lib/calc";
import PageShell from "@/components/shared/PageShell";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  await requireOwnBusiness();
  const alerts = await getOpenAlerts();
  const [t, locale] = await Promise.all([getTranslations("Alerts"), getLocale()]);
  const tCommon = await getTranslations("Common");
  const tCategories = await getTranslations("Categories");
  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<ExpenseCategoryCode, string>;

  const knownImpacts = alerts.filter((a) => a.impactCents !== null && Number.isSafeInteger(a.impactCents));
  const leakingCents = knownImpacts.reduce((s, a) => s + Math.max(0, a.impactCents ?? 0), 0);

  return (
    <PageShell className="flex flex-col gap-3.5 px-4 py-6 pb-10">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={tCommon("back")} />

      <div className="grid grid-cols-2 gap-2.5">
        <div className="flex flex-col gap-1.5 rounded-[22px] bg-card p-4">
          <span className="text-sm font-bold text-warn">{t("potentialImpact")}</span>
          <span className="font-headline text-[36px] font-bold leading-none text-warn">{alerts.length === 0 ? formatCents(0, locale) : knownImpacts.length ? formatCents(leakingCents, locale) : "—"}</span>
          <span className="text-[13px] text-ink-muted">{knownImpacts.length < alerts.length ? t("impactPartialHint") : t("impactHint")}</span>
        </div>
        <div className="flex flex-col gap-1.5 rounded-[22px] bg-card p-4">
          <span className="text-sm font-bold text-good">{t("allClear")}</span>
          <span className="font-headline text-[36px] font-bold leading-none text-good">{alerts.length === 0 ? "✓" : new Intl.NumberFormat(locale).format(alerts.length)}</span>
          <span className="text-[13px] text-ink-muted">{alerts.length === 0 ? t("nothingOpen") : t("openCount")}</span>
        </div>
      </div>

      {alerts.length === 0 ? (
        <p className="rounded-card-lg bg-card p-5 text-center text-base text-ink-muted">{t("emptyState")}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {alerts.map((alert) => {
            const content = describeAlert(alert, t, (code) => categoryLabels[code as ExpenseCategoryCode] ?? code);
            const detailHref = `/more/alerts/${encodeURIComponent(alert.id)}`;
            return (
              <AlertCard
                key={alert.id}
                href={detailHref}
                icon={content.icon}
                title={content.title}
                subtitle={content.subtitle}
                impactCents={alert.impactCents}
                locale={locale}
                reviewLabel={content.actionHref === detailHref ? content.actionLabel : undefined}
              />
            );
          })}
        </div>
      )}
    </PageShell>
  );
}
