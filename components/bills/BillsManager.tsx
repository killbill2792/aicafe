"use client";

import { useState, useTransition } from "react";
import PlainIcon from "@/components/icons/PlainIcon";
import Money from "@/components/shared/Money";
import { saveRecurringCost, deleteRecurringCost } from "@/lib/actions/expenses";
import type { RecurringCostRow } from "@/lib/data/getRecurringCosts";
import type { ExpenseCategoryCode } from "@/lib/constants";
import { recurringCostAmountCentsFromInput } from "@/lib/expenses/recurringCostAmount";
import { totalMonthlyRecurringCostsCents } from "@/lib/expenses/recurringMonthlyTotal";

const SINGLE_SLOT_CATEGORIES: ExpenseCategoryCode[] = ["rent", "utilities_power", "water", "internet", "insurance", "loan", "software"];
const OTHER_CATEGORY: ExpenseCategoryCode = "other";
// Sentinel key (not a real bill id) for the blank "add another Other bill" form.
const NEW_OTHER_KEY = "__new_other__";

type BillFormLabels = { amountLabel: string; dueDayLabel: string; labelLabel: string; labelPlaceholder: string; save: string; delete: string };

function BillForm({
  existing,
  category,
  defaultLabel,
  showLabelField,
  onDone,
  labels,
}: {
  existing: RecurringCostRow | null;
  category: ExpenseCategoryCode;
  defaultLabel: string;
  showLabelField: boolean;
  onDone: () => void;
  labels: BillFormLabels;
}) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [amount, setAmount] = useState(existing ? String(existing.amountCents / 100) : "");
  const [dueDay, setDueDay] = useState(existing?.dueDay ? String(existing.dueDay) : "1");
  const [isPending, startTransition] = useTransition();

  const finalLabel = showLabelField ? label.trim() : defaultLabel;
  const amountCents = recurringCostAmountCentsFromInput(amount);
  // Blank means "not provided"; zero is a valid owner-confirmed value (for example, no loan).
  const canSave = Boolean(finalLabel) && amountCents !== null;

  function handleSave() {
    if (!canSave || amountCents === null) return;
    startTransition(async () => {
      await saveRecurringCost({
        id: existing?.id,
        category,
        label: finalLabel,
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
      {showLabelField && (
        <label className="flex flex-col gap-1 text-sm font-semibold">
          {labels.labelLabel}
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={labels.labelPlaceholder}
            className="h-11 rounded-xl border border-line px-2.5 text-base"
          />
        </label>
      )}
      <label className="flex items-center justify-between gap-2 text-sm font-semibold">
        {labels.amountLabel}
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
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
        <button type="button" onClick={handleSave} disabled={isPending || !canSave} className="h-11 flex-1 rounded-full bg-ink text-sm font-bold text-paper disabled:opacity-40">
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
  initialCategory = null,
}: {
  bills: RecurringCostRow[];
  categoryLabels: Record<ExpenseCategoryCode, string>;
  labels: BillFormLabels & { addHint: string; edit: string; addAnother: string; totalMonthly: string };
  initialCategory?: ExpenseCategoryCode | null;
}) {
  const [openKey, setOpenKey] = useState<string | null>(initialCategory);
  const byCategory = new Map(bills.filter((b) => SINGLE_SLOT_CATEGORIES.includes(b.categoryCode)).map((b) => [b.categoryCode, b]));
  const otherBills = bills.filter((b) => b.categoryCode === OTHER_CATEGORY);

  function toggle(key: string) {
    setOpenKey((prev) => (prev === key ? null : key));
  }

  const totalMonthlyCents = totalMonthlyRecurringCostsCents(bills);

  return (
    <div className="flex flex-col gap-2.5">
      <section className="rounded-card-lg bg-good-tint p-4">
        <span className="block text-sm font-semibold text-ink-muted">{labels.totalMonthly}</span>
        <strong className="mt-1 block font-headline text-3xl text-ink">
          <Money cents={totalMonthlyCents} />
        </strong>
      </section>
      {SINGLE_SLOT_CATEGORIES.map((category) => {
        const existing = byCategory.get(category) ?? null;
        const isOpen = openKey === category;
        return (
          <div key={category} className="flex flex-col gap-2.5 rounded-card-lg bg-card p-4">
            <button type="button" onClick={() => toggle(category)} className="flex items-center gap-3">
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
                defaultLabel={categoryLabels[category]}
                showLabelField={false}
                onDone={() => setOpenKey(null)}
                labels={labels}
              />
            )}
          </div>
        );
      })}

      {/* Custom "Other" bills are repeatable — real cafés end up with a handful of bills that
          don't fit any fixed category, each needing its own owner-typed name. Each one gets its
          own full card, same visual tier as Rent/Electricity/etc., not nested under one bucket —
          her spreadsheet lists these as individual line items, not sub-items of "Other". */}
      {otherBills.map((bill) => {
        const isOpen = openKey === bill.id;
        return (
          <div key={bill.id} className="flex flex-col gap-2.5 rounded-card-lg bg-card p-4">
            <button type="button" onClick={() => toggle(bill.id)} className="flex items-center gap-3">
              <PlainIcon code={OTHER_CATEGORY} size={32} color="#2A1D14" />
              <span className="min-w-0 flex-1 truncate text-start text-base font-bold">{bill.label}</span>
              <span className="text-base font-bold">
                <Money cents={bill.amountCents} />
              </span>
            </button>
            {isOpen && (
              <BillForm
                existing={bill}
                category={OTHER_CATEGORY}
                defaultLabel={bill.label}
                showLabelField
                onDone={() => setOpenKey(null)}
                labels={labels}
              />
            )}
          </div>
        );
      })}

      {openKey === NEW_OTHER_KEY ? (
        <div className="flex flex-col gap-2.5 rounded-card-lg bg-card p-4">
          <BillForm
            existing={null}
            category={OTHER_CATEGORY}
            defaultLabel=""
            showLabelField
            onDone={() => setOpenKey(null)}
            labels={labels}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => toggle(NEW_OTHER_KEY)}
          className="flex items-center gap-3 rounded-card-lg bg-card p-4 text-start text-base font-bold text-good"
        >
          <PlainIcon code={OTHER_CATEGORY} size={32} color="currentColor" />
          {labels.addAnother}
        </button>
      )}
    </div>
  );
}
