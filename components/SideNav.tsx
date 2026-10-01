"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { NAV_TABS } from "@/components/shared/navTabs";

/** Desktop/tablet counterpart to TabBar — same 5 destinations, same wording, same icons (shared
 * via NAV_TABS), just laid out as a fixed left column instead of a bottom bar, since a bottom tab
 * bar spread across a 1200px+ screen doesn't read well. Hidden on mobile (TabBar handles that). */
export default function SideNav() {
  const t = useTranslations("Nav");
  const tLayout = useTranslations("LocaleLayout");
  const pathname = usePathname();

  if (pathname === "/login") return null;

  return (
    <nav aria-label={t("ariaLabel")} className="sticky top-0 hidden h-screen w-sidenav shrink-0 flex-col gap-1 border-e border-line bg-card px-3 py-6 md:flex">
      <div className="px-2 pb-6 font-headline text-xl font-bold text-ink">{tLayout("title")}</div>
      <ul className="flex flex-col gap-1">
        {NAV_TABS.map(({ href, key, Icon }) => {
          const isActive = pathname === href;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={`flex min-h-12 items-center gap-3 rounded-full px-3 text-[15px] font-semibold ${isActive ? "bg-good-tint text-good" : "text-ink-muted"}`}
              >
                <Icon aria-hidden="true" size={20} />
                {t(key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
