import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getSnapshot } from "@/lib/data/getSnapshot";
import { buildScenarioViewModel } from "@/lib/viewmodels/scenarioViewModel";
import BackHeader from "@/components/shared/BackHeader";
import TryScenario from "@/components/scenario/TryScenario";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function TryScenarioPage() {
  await requireOwnBusiness();
  const t = await getTranslations("Scenario");
  const tCommon = await getTranslations("Common");

  const snapshot = await getSnapshot();
  const vm = buildScenarioViewModel(snapshot);

  return (
    <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={tCommon("back")} />
      <section className="flex flex-col gap-4 rounded-card-lg bg-card p-[18px]">
        <TryScenario items={vm.items} avgDailyContributionCents={vm.avgDailyContributionCents} />
      </section>
      <p className="mx-1 text-[13px] leading-snug text-ink-muted">{t("footer")}</p>
    </main>
  );
}
