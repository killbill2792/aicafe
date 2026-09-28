import type { BusinessSnapshot } from "@/lib/data/types";
import { dayContributionCents } from "./costRecoveryShared";

export type ScenarioItem = {
  id: string;
  name: string;
  ingredientsCentsToday: number;
  avgDrinksPerDay: number;
};

export type ScenarioViewModel = {
  items: ScenarioItem[];
  avgDailyContributionCents: number;
};

export function buildScenarioViewModel(snapshot: BusinessSnapshot): ScenarioViewModel {
  const items: ScenarioItem[] = snapshot.menuItems.map((item) => ({
    id: item.id,
    name: item.name,
    ingredientsCentsToday: item.ingredientsCentsToday,
    avgDrinksPerDay: item.quantitySoldLast28Days / 28,
  }));

  const avgDailyContributionCents =
    snapshot.last28Days.length > 0
      ? snapshot.last28Days.reduce((sum, d) => sum + dayContributionCents(d), 0) / snapshot.last28Days.length
      : 0;

  return { items, avgDailyContributionCents };
}
