import { getLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";

const SHORT_LABEL: Record<string, string> = { en: "EN", es: "ES", ar: "AR" };

/** Cycles to the next language on tap, per docs/02-design-system.md ("always in the header"). */
export default async function LanguageSwitch({ href }: { href: string }) {
  const locale = await getLocale();
  const index = routing.locales.indexOf(locale as (typeof routing.locales)[number]);
  const next = routing.locales[(index + 1) % routing.locales.length];

  return (
    <Link
      href={href}
      locale={next}
      className="flex h-11 items-center rounded-full border border-line bg-card px-3.5 text-[15px] font-semibold text-ink"
    >
      {SHORT_LABEL[locale]} / {SHORT_LABEL[next]}
    </Link>
  );
}
