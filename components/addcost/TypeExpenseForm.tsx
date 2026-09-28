"use client";

import { useState, useTransition } from "react";
import { Delete } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import PlainIcon from "@/components/icons/PlainIcon";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";
import { addManualExpense } from "@/lib/actions/expenses";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import { formatCents } from "@/lib/calc";

const CATEGORY_ICONS: Record<ExpenseCategoryCode, ExpenseIconCode> = {
  rent: "rent",
  utilities_power: "utilities_power",
  water: "water",
  internet: "internet",
  insurance: "insurance",
  loan: "loan",
  software: "software",
  supplies: "supplies",
  repairs: "repairs",
  ingredients: "ingredients",
  other: "other",
};

const KEYPAD_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];

export default function TypeExpenseForm({
  categoryLabels,
  todayDateStr,
  labels,
}: {
  categoryLabels: Record<ExpenseCategoryCode, string>;
  todayDateStr: string;
  labels: {
    amountTitle: string;
    categoryTitle: string;
    vendorLabel: string;
    dateLabel: string;
    save: string;
    saved: string;
    customLabelLabel: string;
    customLabelHint: string;
  };
}) {
  const router = useRouter();
  const [digits, setDigits] = useState(""); // raw digits, interpreted as cents
  const [category, setCategory] = useState<ExpenseCategoryCode | null>(null);
  const [vendor, setVendor] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [date, setDate] = useState(todayDateStr);
  const [status, setStatus] = useState<"idle" | "error" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const amountCents = digits === "" ? 0 : Math.min(Number(digits), 99_999_999);

  function pressKey(key: string) {
    if (key === "back") {
      setDigits((d) => d.slice(0, -1));
    } else if (key !== "") {
      setDigits((d) => (d.length >= 8 ? d : d + key));
    }
  }

  function handleSave() {
    if (amountCents === 0 || !category) return;
    setError(null);
    startTransition(async () => {
      const result = await addManualExpense({
        amountCents,
        category,
        vendor: vendor || undefined,
        spentOn: date,
        customLabel: category === "other" && customLabel ? customLabel : undefined,
      });
      if (result.ok) {
        setStatus("saved");
        setTimeout(() => router.push("/money"), 900);
      } else {
        setStatus("error");
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col items-center gap-4 rounded-card-lg bg-card p-5">
        <span className="font-headline text-money-sm font-bold">{formatCents(amountCents)}</span>
        <div className="grid w-full grid-cols-3 gap-2">
          {KEYPAD_KEYS.map((key, i) =>
            key === "" ? (
              <span key={i} />
            ) : (
              <button
                key={i}
                type="button"
                onClick={() => pressKey(key)}
                aria-label={key === "back" ? "Backspace" : key}
                className="flex h-14 items-center justify-center rounded-2xl bg-paper text-2xl font-bold text-ink"
              >
                {key === "back" ? <Delete aria-hidden="true" size={22} /> : key}
              </button>
            ),
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
        <h2 className="text-base font-bold">{labels.categoryTitle}</h2>
        <div className="grid grid-cols-3 gap-2">
          {EXPENSE_CATEGORY_CODES.filter((c) => c !== "ingredients").map((code) => (
            <button
              key={code}
              type="button"
              aria-pressed={category === code}
              onClick={() => setCategory(code)}
              className={`flex flex-col items-center gap-1.5 rounded-2xl p-3 text-center ${
                category === code ? "bg-good-tint text-good" : "bg-paper text-ink"
              }`}
            >
              <PlainIcon code={CATEGORY_ICONS[code]} size={26} />
              <span className="text-xs font-semibold leading-tight">{categoryLabels[code]}</span>
            </button>
          ))}
        </div>
      </section>

      {category === "other" && (
        <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
          <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink-muted">
            {labels.customLabelLabel}
            <input
              type="text"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder={labels.customLabelHint}
              className="h-12 rounded-xl border border-line px-3 text-base text-ink"
            />
          </label>
        </section>
      )}

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
        <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink-muted">
          {labels.vendorLabel}
          <input
            type="text"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            className="h-12 rounded-xl border border-line px-3 text-base text-ink"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink-muted">
          {labels.dateLabel}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-12 rounded-xl border border-line px-3 text-base text-ink"
          />
        </label>
      </section>

      {error && <p className="text-sm text-warn">{error}</p>}

      <button
        type="button"
        onClick={handleSave}
        disabled={amountCents === 0 || !category || isPending}
        className="h-14 rounded-full bg-ink text-lg font-bold text-paper disabled:opacity-40"
      >
        {status === "saved" ? labels.saved : labels.save}
      </button>
    </div>
  );
}
