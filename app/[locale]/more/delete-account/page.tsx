import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";
import DeleteAccountForm from "@/components/more/DeleteAccountForm";
import PageShell from "@/components/shared/PageShell";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function DeleteAccountPage() {
  await requireUser();
  const t = await getTranslations("DeleteAccount");
  const tCommon = await getTranslations("Common");

  return (
    <PageShell className="flex flex-col gap-4 px-4 py-6 pb-10">
      <BackHeader title={t("title")} backHref="/more" backLabel={tCommon("back")} />
      <div className="rounded-card-lg bg-warn-tint p-4 text-sm leading-snug text-[#6E2A07]">{t("warning")}</div>
      <ul className="flex flex-col gap-1.5 rounded-card-lg bg-card p-4 text-sm text-ink-muted">
        <li>{t("bullet1")}</li>
        <li>{t("bullet2")}</li>
        <li>{t("bullet3")}</li>
      </ul>
      <DeleteAccountForm
        labels={{
          confirmPrompt: t("confirmPrompt", { word: t("confirmWord") }),
          confirmPlaceholder: t("confirmWord"),
          confirmWord: t("confirmWord"),
          delete: t("deleteButton"),
          deleting: t("deleting"),
          error: t("error"),
        }}
      />
    </PageShell>
  );
}
