"use client";

import { Home, Wallet, Coffee, Users, MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";

const TABS = [
  { href: "/", key: "home", Icon: Home },
  { href: "/money", key: "money", Icon: Wallet },
  { href: "/menu", key: "menu", Icon: Coffee },
  { href: "/staff", key: "staff", Icon: Users },
  { href: "/more", key: "more", Icon: MoreHorizontal },
] as const;

export default function TabBar() {
  const t = useTranslations("Nav");
  const pathname = usePathname();

  if (pathname === "/login") return null;

  return (
    <nav
      aria-label={t("ariaLabel")}
      className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-card pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="mx-auto flex max-w-app justify-between px-2">
        {TABS.map(({ href, key, Icon }) => {
          const isActive = pathname === href;
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
