import { getTranslations } from "next-intl/server";
import PageShell from "@/components/shared/PageShell";
import PasswordRecoveryForm from "@/components/PasswordRecoveryForm";
export const dynamic = "force-dynamic";
export default async function ResetPasswordPage() {
  const t = await getTranslations("PasswordRecovery");
  return <PageShell className="flex min-h-screen flex-col gap-6 px-6 py-12">
    <h1 className="font-headline text-4xl font-bold text-ink">{t("updateTitle")}</h1>
    <PasswordRecoveryForm mode="update" />
  </PageShell>;
}
