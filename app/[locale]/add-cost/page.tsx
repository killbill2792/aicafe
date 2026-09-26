import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function AddCostPage() {
  await requireUser();
  const t = await getTranslations("AddCost");
  const tCommon = await getTranslations("Common");

  return (
    <main className="flex flex-col gap-5 px-4 py-6">
      <BackHeader title={t("title")} backLabel={tCommon("back")} />
      <p className="text-[17px] leading-snug text-ink-muted">{t("placeholder")}</p>
    </main>
  );
}
