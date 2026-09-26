"use client";

import { useState, useTransition } from "react";
import PlainIcon from "@/components/icons/PlainIcon";
import Money from "@/components/shared/Money";
import { saveRecurringCost, deleteRecurringCost } from "@/lib/actions/expenses";
import type { RecurringCostRow } from "@/lib/data/getRecurringCosts";
import type { ExpenseCategoryCode } from "@/lib/constants";

const BILL_CATEGORIES: ExpenseCategoryCode[] = ["rent", "utilities_power", "water", "internet", "insurance", "loan", "software", "other"];

function BillForm({
  existing,
  category,
  categoryLabels,
  onDone,
  labels,
}: {
  existing: RecurringCostRow | null;
  category: ExpenseCategoryCode;
  categoryLabels: Record<ExpenseCategoryCode, string>;
  onDone: () => void;
  labels: { amountLabel: string; dueDayLabel: string; save: string; delete: string };
}) {
  const [amount, setAmount] = useState(existing ? String(existing.amountCents / 100) : "");
  const [dueDay, setDueDay] = useState(existing?.dueDay ? String(existing.dueDay) : "1");
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const amountCents = Math.round(Number(amount) * 100);
    if (!amountCents || amountCents <= 0) return;
    startTransition(async () => {
      await saveRecurringCost({
        id: existing?.id,
        category,
        label: categoryLabels[category],
        amountCents,
        frequency: "monthly",
        dueDay: Number(dueDay) || undefined,
      });
      onDone();
    });
  }

  function handleDelete() {
    if (!existing) return;
    startTransition(async () => {
      await deleteRecurringCost(existing.id);
      onDone();
    });
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl bg-paper p-3.5">
      <label className="flex items-center justify-between gap-2 text-sm font-semibold">
        {labels.amountLabel}
        <input
          type="number"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="h-11 w-28 rounded-xl border border-line px-2.5 text-end text-base"
        />
      </label>
      <label className="flex items-center justify-between gap-2 text-sm font-semibold">
        {labels.dueDayLabel}
        <input
          type="number"
          min={1}
          max={31}
          value={dueDay}
          onChange={(e) => setDueDay(e.target.value)}
          className="h-11 w-20 rounded-xl border border-line px-2.5 text-end text-base"
        />
      </label>
      <div className="flex gap-2">
        <button type="button" onClick={handleSave} disabled={isPending} className="h-11 flex-1 rounded-full bg-ink text-sm font-bold text-paper">
          {labels.save}
        </button>
        {existing && (
          <button type="button" onClick={handleDelete} disabled={isPending} className="h-11 rounded-full border border-warn px-4 text-sm font-bold text-warn">
            {labels.delete}
          </button>
        )}
      </div>
    </div>
  );
}

export default function BillsManager({
  bills,
  categoryLabels,
  labels,
}: {
  bills: RecurringCostRow[];
  categoryLabels: Record<ExpenseCategoryCode, string>;
  labels: { amountLabel: string; dueDayLabel: string; save: string; delete: string; addHint: string; edit: string };
}) {
  const [openCategory, setOpenCategory] = useState<ExpenseCategoryCode | null>(null);
  const byCategory = new Map(bills.map((b) => [b.categoryCode, b]));

  return (
    <div className="flex flex-col gap-2.5">
      {BILL_CATEGORIES.map((category) => {
        const existing = byCategory.get(category) ?? null;
        const isOpen = openCategory === category;
        return (
          <div key={category} className="flex flex-col gap-2.5 rounded-card-lg bg-card p-4">
            <button type="button" onClick={() => setOpenCategory(isOpen ? null : category)} className="flex items-center gap-3">
              <PlainIcon code={category} size={32} color="#2A1D14" />
              <span className="flex-1 text-start text-base font-bold">{categoryLabels[category]}</span>
              {existing ? (
                <span className="text-base font-bold">
                  <Money cents={existing.amountCents} />
                </span>
              ) : (
                <span className="text-sm font-semibold text-ink-muted">{labels.addHint}</span>
              )}
            </button>
            {isOpen && (
              <BillForm
                existing={existing}
                category={category}
                categoryLabels={categoryLabels}
                onDone={() => setOpenCategory(null)}
                labels={labels}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
