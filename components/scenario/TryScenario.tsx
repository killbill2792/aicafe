"use client";
import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { simulatePlanChange, type PlanScenarioBase, type PlanScenarioItem } from "@/lib/calc/planGoals";

const WAGE_CENTS = 1950;
export default function TryScenario({ items, base }: { items: PlanScenarioItem[]; base: PlanScenarioBase | null }) {
  const t = useTranslations("Scenario");
  const locale = useLocale();
  const [kind, setKind] = useState<"price" | "ingredient" | "staff">("price");
  const [id, setId] = useState(items.find(item => item.costStatus === "READY" && item.quantitySoldLast28Days > 0)?.id ?? "");
  const picked = items.find(item => item.id === id) ?? null;
  const [value, setValue] = useState(() => String((items.find(item => item.costStatus === "READY" && item.quantitySoldLast28Days > 0)?.priceCents ?? 0) / 100));
  const [staffHours, setStaffHours] = useState("0");
  const [presetKind, setPresetKind] = useState<"allPrices" | "milk" | null>(null);
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
  const invalid = !Number.isFinite(Number(value)) || value.trim() === "" || Number(value) < 0 || Number(value) > 100000;
  const result = useMemo(() => base && !invalid ? simulatePlanChange({
    base, type: kind, item: picked, items, preset: presetKind,
    newValueCents: Math.round(Number(value) * 100),
    staffHoursPerDay: kind === "staff" ? Number(staffHours) : 0,
    assumedHourlyWageCents: WAGE_CENTS,
  }) : null, [base, invalid, kind, picked, items, presetKind, staffHours, value]);

  function pickType(next: "price" | "ingredient" | "staff") {
    setKind(next);
    setPresetKind(null);
    setValue(((next === "price" ? picked?.priceCents : picked?.ingredientsCentsToday) ?? 0) / 100 + "");
  }
  function pickItem(next: string) {
    setId(next);
    setPresetKind(null);
    const item = items.find(entry => entry.id === next);
    setValue(((kind === "price" ? item?.priceCents : item?.ingredientsCentsToday) ?? 0) / 100 + "");
  }
  function preset(type: "price" | "ingredient" | "staff", deltaCents: number) {
    pickType(type);
    if (type === "staff") setStaffHours("3");
    else {
      setPresetKind(type === "price" ? "allPrices" : "milk");
      setValue(String(deltaCents / 100));
    }
  }

  return <div className="flex flex-col gap-4">
    <label className="flex flex-col gap-2 text-[17px] font-semibold">
      {t("changeType")}
      <select className="min-h-12 rounded-xl border border-line bg-card px-3" value={kind}
        onChange={event => pickType(event.target.value as typeof kind)}>
        <option value="price">{t("kindPrice")}</option><option value="ingredient">{t("kindIngredient")}</option>
        <option value="staff">{t("kindStaff")}</option>
      </select>
    </label>
    {kind !== "staff" && !presetKind && <label className="flex flex-col gap-2 text-[17px] font-semibold">
      {t("pickDrink")}
      <select className="min-h-12 rounded-xl border border-line bg-card px-3" value={id} onChange={event => pickItem(event.target.value)}>
        {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>}
    {presetKind && <p className="rounded-xl bg-surface p-3 text-[17px]">{t(presetKind === "allPrices" ? "allPricesExplanation" : "milkExplanation")}</p>}
    {kind === "staff" ? <label className="flex flex-col gap-2 text-[17px] font-semibold">
      {t("staffHours")}<input className="min-h-12 rounded-xl border border-line bg-card px-3" type="number" min="0" max="24" step="0.5"
        value={staffHours} onChange={event => setStaffHours(event.target.value)} />
    </label> : !presetKind && <label className="flex flex-col gap-2 text-[17px] font-semibold">
      {kind === "price" ? t("newPrice") : t("newIngredientCost")}
      <input className="min-h-12 rounded-xl border border-line bg-card px-3" type="number" min="0" step="0.01"
        value={value} onChange={event => setValue(event.target.value)} />
    </label>}
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => preset("price", 25)} className="min-h-12 rounded-full bg-surface px-3 text-[15px] font-semibold">{t("presetPrice")}</button>
      <button type="button" onClick={() => preset("staff", 0)} className="min-h-12 rounded-full bg-surface px-3 text-[15px] font-semibold">{t("presetStaff")}</button>
      <button type="button" onClick={() => preset("ingredient", 100)} className="min-h-12 rounded-full bg-surface px-3 text-[15px] font-semibold">{t("presetMilk")}</button>
    </div>
    {!base ? <p className="rounded-xl bg-surface p-4 text-[17px]">{t("baselineUnknown")}</p> :
      kind !== "staff" && !presetKind && (!picked || picked.costStatus !== "READY" || picked.quantitySoldLast28Days <= 0) ?
        <p className="rounded-xl bg-surface p-4 text-[17px]">{t("noItemSales")}</p> :
      result ? <section aria-live="polite" className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl bg-surface p-4">
          <p className="text-[17px]">{t("effectBreakEven")}</p>
          <strong className="block text-2xl">{money.format(result.monthlyBreakEvenCents / 100)}</strong>
          <p className="text-[15px]">{money.format(result.breakEvenChangeCents / 100)}</p>
        </div>
        <div className="rounded-2xl bg-surface p-4">
          <p className="text-[17px]">{t("effectProfit")}</p>
          <strong className="block text-2xl">{money.format(result.monthlyProfitChangeCents / 100)}</strong>
        </div>
      </section> : <p className="rounded-xl bg-surface p-4 text-[17px]">{t("baselineUnknown")}</p>}
    <p className="text-[15px] text-ink-muted">{kind === "staff" ? t("wageAssumption") : t("priceAssumption")}</p>
  </div>;
}
