export const MENU_DETAIL_TABS = ["overview", "recipe", "pricing"] as const;
export type MenuDetailTab = (typeof MENU_DETAIL_TABS)[number];

export function parseMenuDetailTab(value: string | undefined | null): MenuDetailTab {
  return MENU_DETAIL_TABS.find((tab) => tab === value) ?? "overview";
}

export function menuItemHref(itemId: string, tab: MenuDetailTab): string {
  return `/menu/${encodeURIComponent(itemId)}?tab=${tab}`;
}
