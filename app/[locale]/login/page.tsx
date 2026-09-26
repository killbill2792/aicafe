import { ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import LoginForm from "@/components/LoginForm";

const LANGUAGE_LABELS: Record<string, string> = {
  en: "English",
  es: "Español",
  ar: "العربية",
};

export default async function LoginPage() {
  const t = await getTranslations("Login");

  return (
    <main className="flex min-h-screen flex-col gap-6 px-6 pb-10 pt-12">
      <div className="flex gap-2">
        {routing.locales.map((loc) => (
          <Link
            key={loc}
            href="/login"
            locale={loc}
            className="rounded-full border border-line bg-card px-4 py-2 text-[15px] font-semibold text-ink"
          >
            {LANGUAGE_LABELS[loc]}
          </Link>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <h1 className="font-headline text-4xl font-bold leading-tight text-ink">{t("headline")}</h1>
        <p className="text-[18px] leading-snug text-ink-muted">{t("subhead")}</p>
      </div>

      <div className="flex items-start gap-3 rounded-2xl bg-card p-4 text-[15px] leading-snug text-ink">
        <ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0 text-good" size={22} />
        <span>{t("trustLine")}</span>
      </div>

      <div className="mt-auto rounded-3xl bg-card p-5">
        <LoginForm />
      </div>
    </main>
  );
}
