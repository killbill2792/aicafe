"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Link } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import PlainIcon from "@/components/icons/PlainIcon";
import { saveRecurringCost, deleteRecurringCost } from "@/lib/actions/expenses";
import type { RecurringCostRow } from "@/lib/data/getRecurringCosts";
import type { ExpenseCategoryCode } from "@/lib/constants";
import { recurringCostAmountCentsFromInput } from "@/lib/expenses/recurringCostAmount";
import { totalMonthlyRecurringCostsCents } from "@/lib/expenses/recurringMonthlyTotal";

const SINGLE_SLOT_CATEGORIES: ExpenseCategoryCode[] = ["rent", "utilities_power", "water", "internet", "insurance", "loan", "software"];
const OTHER_CATEGORY: ExpenseCategoryCode = "other";
// Sentinel key (not a real bill id) for the blank "add another Other bill" form.
const NEW_OTHER_KEY = "__new_other__";

type BillFormLabels = { amountLabel: string; amountHint: string; dueDayLabel: string; dueDayOptional: string; labelLabel: string; labelPlaceholder: string; save: string; delete: string; confirmRemove: string; saveError: string; removeError: string };

function BillForm({
  existing,
  category,
  defaultLabel,
  showLabelField,
  onDone,
  labels,
  amountInputRef,
}: {
  amountInputRef?: React.Ref<HTMLInputElement>;
  existing: RecurringCostRow | null;
  category: ExpenseCategoryCode;
  defaultLabel: string;
  showLabelField: boolean;
  onDone: () => void;
  labels: BillFormLabels;
}) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [amount, setAmount] = useState(existing ? String(existing.amountCents / 100) : "");
  const [dueDay, setDueDay] = useState(existing?.dueDay ? String(existing.dueDay) : "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const actionLock = useRef(false);

  const finalLabel = showLabelField ? label.trim() : defaultLabel;
  const amountCents = recurringCostAmountCentsFromInput(amount);
  // Blank means "not provided"; zero is a valid owner-confirmed value (for example, no loan).
  const canSave = Boolean(finalLabel) && amountCents !== null;

  function handleSave() {
    if (!canSave || amountCents === null || actionLock.current) return;
    actionLock.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const result = await saveRecurringCost({
          id: existing?.id,
          category,
          label: finalLabel,
          amountCents,
          frequency: "monthly",
          dueDay: Number(dueDay) || undefined,
        });
        if (result.ok) onDone();
        else setError(labels.saveError);
      } catch {
        setError(labels.saveError);
      } finally {
        actionLock.current = false;
      }
    });
  }

  function handleDelete() {
    if (!existing || actionLock.current || !window.confirm(labels.confirmRemove)) return;
    actionLock.current = true;
    setError(null);
    startTransition(async () => {
      try {
        const result = await deleteRecurringCost(existing.id);
        if (result.ok) onDone();
        else setError(labels.removeError);
      } catch {
        setError(labels.removeError);
      } finally {
        actionLock.current = false;
      }
    });
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-2xl bg-paper p-3.5">
      {showLabelField && (
        <label className="flex flex-col gap-1 text-[17px] font-semibold">
          {labels.labelLabel}
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={labels.labelPlaceholder}
            className="min-h-12 rounded-xl border border-line px-2.5 text-[17px]"
          />
        </label>
      )}
      <label className="flex items-center justify-between gap-2 text-[17px] font-semibold">
        {labels.amountLabel}
        <input
          ref={amountInputRef}
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="min-h-12 w-28 rounded-xl border border-line px-2.5 text-end text-[17px]"
        />
      </label>
      <p className="text-[13px] text-ink-muted">{labels.amountHint}</p>
      <label className="flex items-center justify-between gap-2 text-sm font-semibold">
        <span>{labels.dueDayLabel} <span className="font-normal text-ink-muted">{labels.dueDayOptional}</span></span>
        <input
          type="number"
          min={1}
          max={31}
          value={dueDay}
          onChange={(e) => setDueDay(e.target.value)}
          className="min-h-12 w-20 rounded-xl border border-line px-2.5 text-end text-[17px]"
        />
      </label>
      {error && <p role="alert" className="text-[17px] text-warn">{labels.saveError}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={handleSave} disabled={isPending || !canSave || actionLock.current} className="min-h-12 flex-1 rounded-full bg-accent text-[17px] font-bold text-on-accent disabled:opacity-40">
          {labels.save}
        </button>
        {existing && (
          <button type="button" onClick={handleDelete} disabled={isPending || actionLock.current} className="min-h-12 rounded-full border border-warn px-4 text-[17px] font-bold text-warn">
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
  labels: BillFormLabels & { addHint: string; missing: string; edit: string; addAnother: string; totalMonthly: string; variableCostHint: string };
  initialCategory?: ExpenseCategoryCode | null;
}) {
  const locale = useLocale();
  const money = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
  const firstOtherBill = bills.find((bill) => bill.categoryCode === OTHER_CATEGORY);
  const initialOpenKey = initialCategory === OTHER_CATEGORY ? firstOtherBill?.id ?? NEW_OTHER_KEY : initialCategory;
  const [openKey, setOpenKey] = useState<string | null>(initialOpenKey);
  const targetRef = useRef<HTMLDivElement | null>(null);
  const amountRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!initialCategory) return;
    targetRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
    amountRef.current?.focus({ preventScroll: true });
  }, [initialCategory]);
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
          {money.format(totalMonthlyCents / 100)}
        </strong>
      </section>
      {SINGLE_SLOT_CATEGORIES.map((category) => {
        const existing = byCategory.get(category) ?? null;
        const isOpen = openKey === category;
        return (
          <div key={category} ref={initialCategory === category ? targetRef : undefined} className="flex flex-col gap-2.5 rounded-card-lg bg-card p-4">
            <button type="button" onClick={() => toggle(category)} className="flex min-h-12 items-center gap-3">
              <PlainIcon code={category} size={32} color="currentColor" />
              <span className="flex-1 text-start text-[17px] font-bold">{categoryLabels[category]}</span>
              {existing ? (
                <span className="text-[17px] font-bold">
                  {money.format(existing.amountCents / 100)}
                </span>
              ) : (
                <span className="rounded-full bg-warn-tint px-2.5 py-1 text-[13px] font-bold text-warn">{labels.missing}</span>
              )}
            </button>
            {isOpen && (
              <BillForm
                existing={existing}
                amountInputRef={initialCategory === category ? amountRef : undefined}
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
          <div key={bill.id} ref={initialCategory === OTHER_CATEGORY && bill.id === initialOpenKey ? targetRef : undefined} className="flex flex-col gap-2.5 rounded-card-lg bg-card p-4">
            <button type="button" onClick={() => toggle(bill.id)} className="flex items-center gap-3">
              <PlainIcon code={OTHER_CATEGORY} size={32} color="currentColor" />
              <span className="min-w-0 flex-1 truncate text-start text-[17px] font-bold">{bill.label}</span>
              <span className="text-[17px] font-bold">
                {money.format(bill.amountCents / 100)}
              </span>
            </button>
            {isOpen && (
              <BillForm
                existing={bill}
                amountInputRef={initialCategory === OTHER_CATEGORY && bill.id === initialOpenKey ? amountRef : undefined}
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
        <div ref={initialCategory === OTHER_CATEGORY ? targetRef : undefined} className="flex flex-col gap-2.5 rounded-card-lg bg-card p-4">
          <BillForm
            amountInputRef={initialCategory === OTHER_CATEGORY ? amountRef : undefined}
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
          className="flex items-center gap-3 rounded-card-lg bg-card p-4 text-start text-[17px] font-bold text-good"
        >
          <PlainIcon code={OTHER_CATEGORY} size={32} color="currentColor" />
          {labels.addAnother}
        </button>
      )}
      <Link href="/add-cost" className="mt-2 text-sm text-ink-muted underline underline-offset-2">{labels.variableCostHint}</Link>
    </div>
  );
}
