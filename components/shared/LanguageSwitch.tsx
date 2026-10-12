import { getLocale } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { Languages } from "lucide-react";

const SHORT_LABEL: Record<string, string> = { en: "EN", es: "ES", ar: "AR" };

/** Cycles to the next language on tap, per docs/02-design-system.md ("always in the header"). */
export default async function LanguageSwitch({ href, compact = false }: { href: string; compact?: boolean }) {
  const locale = await getLocale();
  const index = routing.locales.indexOf(locale as (typeof routing.locales)[number]);
  const next = routing.locales[(index + 1) % routing.locales.length];

  return (
    <Link
      href={href}
      locale={next}
      className={compact ? "flex min-h-12 min-w-12 shrink-0 items-center justify-center gap-1 rounded-full border border-line bg-card px-2 text-[13px] font-bold text-ink" : "flex h-11 shrink-0 items-center whitespace-nowrap rounded-full border border-line bg-card px-3.5 text-[15px] font-semibold text-ink"}
      title={`${SHORT_LABEL[locale]} → ${SHORT_LABEL[next]}`}
    >
      {compact ? <><Languages size={17} aria-hidden="true" /> {SHORT_LABEL[locale]}</> : <>{SHORT_LABEL[locale]} / {SHORT_LABEL[next]}</>}
    </Link>
  );
}
