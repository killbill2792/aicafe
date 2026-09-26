import {
  cardFeePerDrinkCents,
  effectiveFeeRate,
  extraMoneyFromOneMoreDrinkCents,
  rentBillsSharePerDrinkCents,
  staffCostCentsForPeriod,
  staffCostPerPrepSecond,
  staffTimePerDrinkCents,
  sumCents,
  trueProfitPerDrinkCents,
} from "@/lib/calc";
import type { BusinessSnapshot, MenuItemSnapshot } from "@/lib/data/types";

export type MenuItemBreakdown = {
  item: MenuItemSnapshot;
  ingredientsCents: number;
  staffTimeCents: number;
  cardFeeCents: number;
  rentBillsShareCents: number;
  yoursCents: number; // true profit per drink
  extraMoneyCents: number; // extra money from one more
};

export function buildMenuViewModel(snapshot: BusinessSnapshot) {
  const totalPrepSecondsSold = snapshot.menuItems.reduce((s, i) => s + i.prepSeconds * i.quantitySoldLast28Days, 0);
  const last28StaffCost = staffCostCentsForPeriod(snapshot.last28Days);
  const perSecond = staffCostPerPrepSecond(last28StaffCost, totalPrepSecondsSold);

  const feeRate = effectiveFeeRate(
    sumCents(snapshot.last28Days, (d) => d.cardFeesCents),
    sumCents(snapshot.last28Days, (d) => d.netSalesCents),
  );

  const totalDrinksSold28d = sumCents(snapshot.last28Days, (d) => d.drinksCount);
  const avgDrinksPerDay = snapshot.last28Days.length ? totalDrinksSold28d / snapshot.last28Days.length : 0;
  const runningCostsPerDay = snapshot.runningCostLines.reduce((s, l) => s + l.amountCents, 0) / snapshot.daysInMonth;
  const rentBillsShare = rentBillsSharePerDrinkCents(runningCostsPerDay, avgDrinksPerDay);

  const items: MenuItemBreakdown[] = snapshot.menuItems.map((item) => {
    const staffTimeCents = staffTimePerDrinkCents(item.prepSeconds, perSecond);
    const cardFeeCents = cardFeePerDrinkCents(item.priceCents, feeRate);
    const extraMoneyCents = extraMoneyFromOneMoreDrinkCents(item.priceCents, item.ingredientsCentsToday, cardFeeCents, staffTimeCents);
    const yoursCents = trueProfitPerDrinkCents(extraMoneyCents, rentBillsShare);
    return {
      item,
      ingredientsCents: item.ingredientsCentsToday,
      staffTimeCents,
      cardFeeCents,
      rentBillsShareCents: rentBillsShare,
      yoursCents,
      extraMoneyCents,
    };
  });

  const sortedByYours = [...items].sort((a, b) => b.yoursCents - a.yoursCents);
  const bestEarner = sortedByYours[0] ?? null;
  const lowestEarner = sortedByYours[sortedByYours.length - 1] ?? null;
  // "Featured item" on the Menu screen is the best SELLER (by volume), not the best margin —
  // docs/03-screens.md S6 point 1 vs point 4 are two different things.
  const featured = [...items].sort((a, b) => b.item.quantitySoldLast28Days - a.item.quantitySoldLast28Days)[0] ?? null;

  return { items: sortedByYours, featured, bestEarner, lowestEarner, rentBillsShareCents: rentBillsShare, effectiveFeeRate: feeRate };
}
