import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import SignupForm from "@/components/SignupForm";

export default async function SignupPage() {
  const t = await getTranslations("SignUp");
  return (
    <PageShell className="flex min-h-screen flex-col gap-6 px-6 pb-10 pt-12">
      <Link href="/login" className="text-sm font-semibold text-ink-muted underline">{t("backToSignIn")}</Link>
      <div className="flex flex-col gap-2">
        <h1 className="font-headline text-4xl font-bold text-ink">{t("title")}</h1>
        <p className="text-base text-ink-muted">{t("subtitle")}</p>
      </div>
      <div className="rounded-3xl bg-card p-5">
        <SignupForm />
      </div>
    </PageShell>
  );
}
