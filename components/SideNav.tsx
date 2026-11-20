"use client";

import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { NAV_TABS, isNavTabActive } from "@/components/shared/navTabs";
import { isAuthPath } from "@/lib/auth/authRoutes";

/** Desktop/tablet counterpart to TabBar — same 5 destinations, same wording, same icons (shared
 * via NAV_TABS), just laid out as a fixed left column instead of a bottom bar, since a bottom tab
 * bar spread across a 1200px+ screen doesn't read well. Hidden on mobile (TabBar handles that). */
export default function SideNav({ cafeName, languageSwitch }: { cafeName: string; languageSwitch?: React.ReactNode }) {
  const t = useTranslations("Nav");
  const pathname = usePathname();
  const [collapsed,setCollapsed]=useState(false);
  const compact=pathname==="/"&&collapsed;

  if (isAuthPath(pathname)) return null;

  return (
    <nav aria-label={t("ariaLabel")} className={`sticky top-0 hidden h-screen shrink-0 flex-col gap-1 border-e border-line bg-nav px-3 py-6 md:flex ${compact?"w-[76px]":"w-sidenav"}`}>
      <div className={`flex items-center gap-1 pb-6 ${compact?"justify-center":"justify-between"}`}>
        <div className={`${compact?"sr-only":"min-w-0 break-words px-2 font-headline text-xl font-bold text-ink"}`}>{cafeName}</div>
        {pathname==="/"&&<button type="button" aria-label={t("ariaLabel")} aria-expanded={!compact} title={t("ariaLabel")} onClick={()=>setCollapsed(v=>!v)} className="flex size-12 shrink-0 items-center justify-center rounded-full text-muted hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">{compact?<PanelLeftOpen size={20} aria-hidden="true"/>:<PanelLeftClose size={20} aria-hidden="true"/>}</button>}
      </div>
      <ul className="flex flex-col gap-1">
        {NAV_TABS.map(({ href, key, Icon }) => {
          const isActive = isNavTabActive(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={isActive ? "page" : undefined}
                aria-label={t(key)} title={compact?t(key):undefined}
                className={`flex min-h-12 items-center gap-3 rounded-full px-3 text-[15px] font-semibold ${isActive ? "bg-accent-soft text-accent-text" : "text-muted hover:bg-surface2"}`}
              >
                <Icon aria-hidden="true" size={20} />
                <span className={compact?"sr-only":undefined}>{t(key)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto border-t border-line px-2 pt-4">
        {!compact&&<>{languageSwitch}</>}
      </div>
    </nav>
  );
}
