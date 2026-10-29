import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";
import ReceiptUploader from "@/components/addcost/ReceiptUploader";
import AiUnavailableNotice from "@/components/addcost/AiUnavailableNotice";
import { EXPENSE_CATEGORY_CODES } from "@/lib/constants";
import { isAiConfigured } from "@/lib/ai/types";
import PageShell from "@/components/shared/PageShell";
import { getCafeProfile } from "@/lib/data/getCafeProfile";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function ReceiptUploadPage() {
  await requireOwnBusiness();
  const t = await getTranslations("AddCost");
  const tCommon = await getTranslations("Common");
  const tCategories = await getTranslations("Categories");

  if (!isAiConfigured()) {
    return (
      <PageShell className="flex flex-col gap-5 px-4 py-6 pb-10">
        <BackHeader title={t("optionPhoto")} backHref="/add-cost" backLabel={tCommon("back")} />
        <AiUnavailableNotice title={t("aiUnavailableTitle")} message={t("aiUnavailableReceiptBody")} typeItLabel={t("optionType")} />
      </PageShell>
    );
  }

  const profile = await getCafeProfile();
  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<
    (typeof EXPENSE_CATEGORY_CODES)[number],
    string
  >;

  return (
    <PageShell className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("optionPhoto")} backHref="/add-cost" backLabel={tCommon("back")} />
      {!profile.currency&&<p role="note" className="text-sm text-ink-muted">{tCommon("currencyNotSet")}</p>}
      <ReceiptUploader
        currency={profile.currency}
        categoryLabels={categoryLabels}
        labels={{
          prompt: t("receiptPrompt"),
          takePhoto: t("receiptTakePhoto"),
          reading: t("receiptReading"),
          looksRight: t("receiptLooksRight"),
          saved: t("saved"),
        }}
      />
    </PageShell>
  );
}
