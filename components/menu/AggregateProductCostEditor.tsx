"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, Trash2 } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import { removeMenuItemAggregateCost, saveMenuItemAggregateCost } from "@/lib/actions/menuItems";
import type { MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";

type Labels = {
  title: string;
  help: string;
  perSize: string;
  input: string;
  save: string;
  remove: string;
  saved: string;
  usingOwner: string;
  usingRecipe: string;
  recipeOnly: string;
  missing: string;
  recipeHigher: string;
  recipeLower: string;
  same: string;
  invalid: string;
  error: string;
};

export default function AggregateProductCostEditor({ items, labels }: { items: MenuItemForEdit[]; labels: Labels }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((item) => [item.id, item.ownerTotalCostCents === null ? "" : (item.ownerTotalCostCents / 100).toFixed(2)])),
  );
  const [message, setMessage] = useState<{ id: string; text: string; good: boolean } | null>(null);

  useEffect(() => {
    setValues(Object.fromEntries(items.map((item) => [item.id, item.ownerTotalCostCents === null ? "" : (item.ownerTotalCostCents / 100).toFixed(2)])));
  }, [items]);

  function save(item: MenuItemForEdit) {
    const dollars = Number(values[item.id]);
    const cents = Math.round(dollars * 100);
    if (!Number.isFinite(dollars) || cents <= 0) {
      setMessage({ id: item.id, text: labels.invalid, good: false });
      return;
    }
    startTransition(async () => {
      const result = await saveMenuItemAggregateCost({ menuItemId: item.id, costCents: cents });
      setMessage({ id: item.id, text: result.ok ? labels.saved : labels.error, good: result.ok });
      if (result.ok) router.refresh();
    });
  }

  function remove(item: MenuItemForEdit) {
    startTransition(async () => {
      const result = await removeMenuItemAggregateCost(item.id);
      if (result.ok) {
        setValues((current) => ({ ...current, [item.id]: "" }));
        setMessage({ id: item.id, text: labels.saved, good: true });
        router.refresh();
      } else {
        setMessage({ id: item.id, text: labels.error, good: false });
      }
    });
  }

  function status(item: MenuItemForEdit): string {
    if (item.costSource === "owner_total") return labels.usingOwner;
    if (item.costSource === "recipe" && item.ownerTotalCostCents !== null) return labels.usingRecipe;
    if (item.costSource === "recipe") return labels.recipeOnly;
    return labels.missing;
  }

  function comparison(item: MenuItemForEdit): string | null {
    if (item.recipeCostStatus !== "READY" || item.recipeCostCents === null || item.ownerTotalCostCents === null || item.costDifferenceCents === null) return null;
    if (Math.abs(item.costDifferenceCents) < 0.5) return labels.same;
    return item.costDifferenceCents > 0
      ? labels.recipeHigher.replace("{amount}", formatCents(Math.abs(item.costDifferenceCents)))
      : labels.recipeLower.replace("{amount}", formatCents(Math.abs(item.costDifferenceCents)));
  }

  return (
    <section className="rounded-card-lg border border-line/70 bg-card p-4">
      <h2 className="text-xl font-extrabold text-ink">{labels.title}</h2>
      <p className="mt-1 text-[17px] leading-relaxed text-ink-muted">{labels.help}</p>
      <p className="mt-2 text-sm font-semibold text-ink-muted">{labels.perSize}</p>
      <div className="mt-4 divide-y divide-line">
        {items.map((item) => {
          const compare = comparison(item);
          return (
            <div key={item.id} className="py-4 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-[17px] font-bold text-ink">{item.sizeLabel ?? item.name}</h3>
                  <span className="mt-1 inline-flex rounded-full bg-paper px-2.5 py-1 text-xs font-bold text-ink-muted">{status(item)}</span>
                  {compare && <p className="mt-2 text-sm leading-snug text-ink-muted">{compare}</p>}
                </div>
                {item.costStatus === "READY" && item.ingredientsCostCents !== null && (
                  <span className="text-lg font-extrabold text-ink">{formatCents(item.ingredientsCostCents)}</span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="min-w-[180px] flex-1 text-sm font-semibold text-ink">
                  {labels.input}
                  <span className="mt-1 flex min-h-12 items-center rounded-xl border border-line bg-card px-3">
                    <span className="me-1 font-bold text-ink-muted">$</span>
                    <input
                      inputMode="decimal"
                      value={values[item.id] ?? ""}
                      onChange={(event) => setValues((current) => ({ ...current, [item.id]: event.target.value }))}
                      className="min-w-0 flex-1 bg-transparent text-[17px] outline-none"
                    />
                  </span>
                </label>
                <button type="button" disabled={pending} onClick={() => save(item)} className="min-h-12 rounded-full bg-ink px-4 font-bold text-paper disabled:opacity-40">
                  {labels.save}
                </button>
                {item.ownerTotalCostCents !== null && (
                  <button type="button" disabled={pending} onClick={() => remove(item)} className="flex min-h-12 items-center gap-2 rounded-full px-3 font-bold text-warn disabled:opacity-40">
                    <Trash2 size={18} aria-hidden="true" />
                    {labels.remove}
                  </button>
                )}
              </div>
              {message?.id === item.id && (
                <p className={`mt-2 flex items-center gap-2 text-sm font-semibold ${message.good ? "text-good" : "text-warn"}`} role="status">
                  {message.good && <Check size={17} aria-hidden="true" />}
                  {message.text}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
