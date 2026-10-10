import { Home, Wallet, Coffee, Users, MoreHorizontal, type LucideIcon } from "lucide-react";

export type NavTab = { href: "/" | "/money" | "/menu" | "/staff" | "/more"; key: "home" | "money" | "menu" | "staff" | "more"; Icon: LucideIcon };

/** The app's 5 primary destinations — shared by TabBar (mobile, bottom) and SideNav
 * (desktop/tablet, left) so both surfaces always show the exact same destinations,
 * wording, and icons. The AI Team remains available at /operations through Home's
 * prominent Team button rather than taking a primary-navigation slot. */
export const NAV_TABS: NavTab[] = [
  { href: "/", key: "home", Icon: Home },
  { href: "/money", key: "money", Icon: Wallet },
  { href: "/menu", key: "menu", Icon: Coffee },
  { href: "/staff", key: "staff", Icon: Users },
  { href: "/more", key: "more", Icon: MoreHorizontal },
];

/** A tab stays highlighted on its nested routes too (e.g. `/menu/[itemId]` for Menu,
 * `/more/bills` for More) — only the Home tab ("/") requires an exact match, since every
 * other route is otherwise also prefixed by "/". */
export function isNavTabActive(pathname: string, href: NavTab["href"]): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
