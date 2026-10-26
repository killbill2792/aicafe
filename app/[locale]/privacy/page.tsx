import { getTranslations } from "next-intl/server";
import {Link} from "@/i18n/navigation";
import BackHeader from "@/components/shared/BackHeader";
import PageShell from "@/components/shared/PageShell";

export default async function PrivacyPage() {
  const t = await getTranslations("Privacy");
  const tCommon = await getTranslations("Common");
  const sections = ["whatWeCollect","toastSquare","aiProcessing","staffMessages","retention","deletingYourAccount","contact"] as const;

  return (
    <PageShell className="flex flex-col gap-4 px-4 py-6 pb-10">
      <BackHeader title={t("title")} subtitle={t("lastUpdated")} backHref="/more" backLabel={tCommon("back")} />
      <p role="status" className="rounded-xl border border-line bg-surface2 p-4 text-[17px] font-bold">{t("draftBanner")}</p>
      {sections.map((key) => (
        <section key={key} className="flex flex-col gap-2 rounded-card-lg bg-card p-4">
          <h2 className="text-lg font-bold">{t(`${key}Title`)}</h2>
          <p className="text-[17px] leading-relaxed text-ink-muted">{t(`${key}Body`)}</p>
        </section>
      ))}
    <Link href="/more/delete-account" className="inline-flex min-h-12 items-center text-[17px] text-accent-text underline">{t("deleteLink")}</Link>
    </PageShell>
  );
}
