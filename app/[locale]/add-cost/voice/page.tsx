import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";
import VoiceRecorder from "@/components/addcost/VoiceRecorder";
import { EXPENSE_CATEGORY_CODES } from "@/lib/constants";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function VoiceEntryPage() {
  await requireOwnBusiness();
  const t = await getTranslations("AddCost");
  const tCommon = await getTranslations("Common");
  const tCategories = await getTranslations("Categories");

  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<
    (typeof EXPENSE_CATEGORY_CODES)[number],
    string
  >;

  return (
    <main className="flex flex-col gap-6 px-4 py-6 pb-10">
      <BackHeader title={t("optionVoice")} backHref="/add-cost" backLabel={tCommon("back")} />
      <VoiceRecorder
        categoryLabels={categoryLabels}
        labels={{
          holdToTalk: t("voiceHoldToTalk"),
          listening: t("voiceListening"),
          notSupported: t("voiceNotSupported"),
          typeItInstead: t("optionType"),
          confirm: t("voiceConfirm"),
          saved: t("saved"),
          transcriptLabel: t("voiceTranscriptLabel"),
        }}
      />
    </main>
  );
}
