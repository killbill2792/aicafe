import { Home, Wallet, Coffee, Users, MoreHorizontal, Sparkles, type LucideIcon } from "lucide-react";

export type NavTab = { href: "/" | "/operations" | "/money" | "/menu" | "/staff" | "/more"; key: "home" | "team" | "money" | "menu" | "staff" | "more"; Icon: LucideIcon };

/** The app's 5 destinations — shared by TabBar (mobile, bottom) and SideNav (desktop/tablet,
 * left) so both surfaces always show the exact same destinations, wording, and icons by
 * construction rather than two hand-maintained lists that could drift apart. */
export const NAV_TABS: NavTab[] = [
  { href: "/", key: "home", Icon: Home },
  { href: "/operations", key: "team", Icon: Sparkles },
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
