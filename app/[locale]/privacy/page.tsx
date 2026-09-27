import { getTranslations } from "next-intl/server";
import BackHeader from "@/components/shared/BackHeader";

export default async function PrivacyPage() {
  const t = await getTranslations("Privacy");
  const tCommon = await getTranslations("Common");
  const sections = ["dataWeRead", "dataWeNeverTouch", "howWeProtectIt", "aiUse", "yourControl", "deletingYourAccount"] as const;

  return (
    <main className="flex flex-col gap-4 px-4 py-6 pb-10">
      <BackHeader title={t("title")} subtitle={t("lastUpdated")} backHref="/more" backLabel={tCommon("back")} />
      {sections.map((key) => (
        <section key={key} className="flex flex-col gap-2 rounded-card-lg bg-card p-4">
          <h2 className="text-base font-bold">{t(`${key}Title`)}</h2>
          <p className="text-[15px] leading-relaxed text-ink-muted">{t(`${key}Body`)}</p>
        </section>
      ))}
    </main>
  );
}
