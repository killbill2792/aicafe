import { getTranslations } from "next-intl/server";

export default async function MenuPage() {
  const t = await getTranslations("Menu");

  return (
    <main className="px-4 py-6">
      <h1 className="font-headline text-3xl font-semibold text-ink">
        {t("title")}
      </h1>
      <p className="mt-4 text-ink-muted">{t("placeholder")}</p>
    </main>
  );
}
