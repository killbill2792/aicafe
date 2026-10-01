import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";
import ReceiptUploader from "@/components/addcost/ReceiptUploader";
import { EXPENSE_CATEGORY_CODES } from "@/lib/constants";
import PageShell from "@/components/shared/PageShell";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function ReceiptUploadPage() {
  await requireOwnBusiness();
  const t = await getTranslations("AddCost");
  const tCommon = await getTranslations("Common");
  const tCategories = await getTranslations("Categories");

  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<
    (typeof EXPENSE_CATEGORY_CODES)[number],
    string
  >;

  return (
    <PageShell className="flex flex-col gap-5 px-4 py-6 pb-10">
      <BackHeader title={t("optionPhoto")} backHref="/add-cost" backLabel={tCommon("back")} />
      <ReceiptUploader
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
