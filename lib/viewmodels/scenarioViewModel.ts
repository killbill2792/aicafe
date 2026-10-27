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

  const covered=snapshot.last28Days.filter(d=>dayContributionCents(d)!==null);
  const avgDailyContributionCents =
    covered.length > 0
      ? covered.reduce((sum, d) => sum + (dayContributionCents(d)??0), 0) / covered.length
      : 0;

  return { items, avgDailyContributionCents };
}
