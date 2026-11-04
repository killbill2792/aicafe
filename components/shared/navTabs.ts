import { Home, Inbox, Wallet, Coffee, Users, MoreHorizontal, type LucideIcon } from "lucide-react";

export type NavTab = { href: "/" | "/operations" | "/money" | "/menu" | "/staff" | "/more"; key: "home" | "inbox" | "money" | "menu" | "staff" | "more"; Icon: LucideIcon };

/** The app's primary destinations — shared by TabBar (mobile, bottom) and SideNav
 * (desktop/tablet, left) so both surfaces always show the exact same destinations,
 * wording, and icons. Inbox is the AI team's /operations inbox (Needs you / Watching /
 * Handled, plus Experiments); Home shows its Needs-you count. */
export const NAV_TABS: NavTab[] = [
  { href: "/", key: "home", Icon: Home },
  { href: "/operations", key: "inbox", Icon: Inbox },
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
