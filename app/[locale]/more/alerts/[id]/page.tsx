import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import BackHeader from "@/components/shared/BackHeader";
import Money from "@/components/shared/Money";
import PlainIcon from "@/components/icons/PlainIcon";
import { describeAlert } from "@/components/alerts/alertContent";
import { markAlertStatus, setAlertStatus } from "@/lib/actions/alerts";
import { getAlertById } from "@/lib/data/getAlerts";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function AlertDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwnBusiness();
  const { id } = await params;

  const alert = await getAlertById(id);
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
    <main className="flex flex-col gap-4 px-4 py-6 pb-10">
      <BackHeader title={content.title} backHref="/more/alerts" backLabel={tCommon("back")} />

      <section className="flex flex-col items-center gap-3 rounded-card-lg bg-card p-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-warn-tint text-warn">
          <PlainIcon code={content.icon as ExpenseIconCode} size={26} color="#B4460E" />
        </span>
        {alert.impactCents !== null && (
          <span className="font-headline text-[44px] font-bold leading-none text-warn">
            <Money cents={alert.impactCents} />
          </span>
        )}
        <p className="text-base leading-snug text-ink">{content.subtitle}</p>
      </section>

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
    </main>
  );
}
