import { getTranslations } from "next-intl/server";
import PageShell from "@/components/shared/PageShell";
import PasswordRecoveryForm from "@/components/PasswordRecoveryForm";
export default async function ForgotPasswordPage() {
  const t = await getTranslations("PasswordRecovery");
  return <PageShell className="flex min-h-screen flex-col gap-6 px-6 py-12">
    <h1 className="font-headline text-4xl font-bold text-ink">{t("requestTitle")}</h1>
    <p className="text-ink-muted">{t("requestSubtitle")}</p>
    <PasswordRecoveryForm mode="request" />
  </PageShell>;
}
