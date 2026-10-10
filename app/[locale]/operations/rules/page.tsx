import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import TeamRulesManager from "@/components/operations/TeamRulesManager";
import { authenticatedConversationContext } from "@/lib/ai/conversations/auth.server";

export const dynamic = "force-dynamic";

export default async function TeamRulesPage() {
  // A manager cannot even render the owner's policy editor.
  await authenticatedConversationContext().catch(() => notFound());
  const t = await getTranslations("TeamRules");
  return <PageShell className="flex flex-col gap-4 px-4 pb-28 pt-6">
    <header className="flex flex-col gap-2">
      <Link href="/operations"
        className="flex min-h-12 items-center self-start rounded-full border border-ink px-4 text-[17px] font-bold text-ink no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
        ← {t("back")}
      </Link>
      <h1 className="font-headline text-3xl font-bold text-ink">{t("title")}</h1>
      <p className="text-[17px] leading-relaxed text-ink-muted">{t("intro")}</p>
    </header>
    <TeamRulesManager copy={{
      agent: t("agent"), instruction: t("instruction"), instructionHint: t("instructionHint"),
      saveDraft: t("saveDraft"), rules: t("rules"), audit: t("audit"),
      emptyRules: t("emptyRules"), emptyAudit: t("emptyAudit"),
      approve: t("approve"), reject: t("reject"), pause: t("pause"),
      resume: t("resume"), draft: t("draft"), active: t("active"),
      paused: t("paused"), rejected: t("rejected"), warning: t("warning"),
      loading: t("loading"), saving: t("saving"), error: t("error"),
      conflict: t("conflict"), loadMore: t("loadMore"), by: t("by"),
      created: t("created"), to: t("to"), supervisor: t("supervisor"),
      alex: t("alex"), olivia: t("olivia"), maya: t("maya"), leo: t("leo"),
    }}/>
  </PageShell>;
}
