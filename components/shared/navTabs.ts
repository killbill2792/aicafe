import { Home, Wallet, Coffee, Users, MoreHorizontal, type LucideIcon } from "lucide-react";

export type NavTab = { href: "/" | "/money" | "/menu" | "/staff" | "/more"; key: "home" | "money" | "menu" | "staff" | "more"; Icon: LucideIcon };

/** The app's 5 destinations — shared by TabBar (mobile, bottom) and SideNav (desktop/tablet,
 * left) so both surfaces always show the exact same destinations, wording, and icons by
 * construction rather than two hand-maintained lists that could drift apart. */
export const NAV_TABS: NavTab[] = [
  { href: "/", key: "home", Icon: Home },
  { href: "/money", key: "money", Icon: Wallet },
  { href: "/menu", key: "menu", Icon: Coffee },
  { href: "/staff", key: "staff", Icon: Users },
  { href: "/more", key: "more", Icon: MoreHorizontal },
];
