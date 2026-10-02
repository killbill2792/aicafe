"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { NAV_TABS, isNavTabActive } from "@/components/shared/navTabs";

export default function TabBar() {
  const t = useTranslations("Nav");
  const pathname = usePathname();

  if (pathname === "/login") return null;

  return (
    <nav
      aria-label={t("ariaLabel")}
      className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-card pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="mx-auto flex max-w-app justify-between px-2">
        {NAV_TABS.map(({ href, key, Icon }) => {
          const isActive = isNavTabActive(pathname, href);
          return (
            <li key={href} className="min-w-0 flex-1">
              <Link
                href={href}
                aria-current={isActive ? "page" : undefined}
                className={`flex min-h-[48px] flex-col items-center justify-center gap-1 py-2 text-[13px] ${
                  isActive ? "text-good" : "text-ink-muted"
                }`}
              >
                <Icon aria-hidden="true" size={22} />
                <span>{t(key)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
