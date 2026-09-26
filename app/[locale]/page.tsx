import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  await requireUser();
  const t = await getTranslations("Home");

  return (
    <main className="px-4 py-6">
      <h1 className="font-headline text-3xl font-semibold text-ink">
        {t("title")}
      </h1>
      <p className="mt-4 text-ink-muted">{t("placeholder")}</p>
    </main>
  );
}
