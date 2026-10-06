"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { saveOwnerProcessingFeeEstimatePlan } from "@/lib/actions/processingFeeEstimate";
import type { OwnerConfirmedProcessingFeePlan } from "@/lib/pos/processingFeeEstimate";

type Labels = {
  assumptionBanner: string;
  processor: string;
  processorPlaceholder: string;
  effectiveFrom: string;
  processedSalesShare: string;
  processedSalesShareHint: string;
  processedTransactionShare: string;
  processedTransactionShareHint: string;
  averageTicket: string;
  averageTicketHint: string;
  rulesTitle: string;
  rulesHint: string;
  ruleLabel: string;
  ruleLabelPlaceholder: string;
  percentageRate: string;
  fixedFee: string;
  salesMix: string;
  transactionMix: string;
  remove: string;
  addRule: string;
  save: string;
  saving: string;
  saved: string;
  coverageTitle: string;
  coverageActual: string;
  coverageEstimated: string;
  coverageMissing: string;
  coverageSalesDays: string;
  incompleteWarning: string;
};

type RuleDraft = {
  id: string;
  label: string;
  percentageRate: string;
  fixedFee: string;
  salesMix: string;
  transactionMix: string;
};

function percentFromBps(value: number): string {
  return (value / 100).toFixed(2).replace(/\.00$/, "");
}

function dollarsFromCents(value: number | null): string {
  return value === null ? "" : (value / 100).toFixed(2);
}

function bpsFromPercent(value: string): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
  return Math.round(parsed * 100);
}

function centsFromDollars(value: string, allowBlank = false): number | null {
  if (allowBlank && !value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100);
}

function initialRules(plan: OwnerConfirmedProcessingFeePlan | null): RuleDraft[] {
  if (!plan) {
    return [{ id: "rule-1", label: "", percentageRate: "", fixedFee: "", salesMix: "", transactionMix: "" }];
  }
  return plan.rules.map((rule) => ({
    id: rule.id,
    label: rule.label,
    percentageRate: percentFromBps(rule.percentageBps),
    fixedFee: (rule.fixedFeeCents / 100).toFixed(2),
    salesMix: percentFromBps(rule.salesMixBps),
    transactionMix: percentFromBps(rule.transactionMixBps),
  }));
}

export default function ProcessingFeeEstimateForm({
  plan,
  today,
  coverage,
  labels,
}: {
  plan: OwnerConfirmedProcessingFeePlan | null;
  today: string;
  coverage: { salesDays: number; actualDays: number; estimatedDays: number; missingDays: number };
  labels: Labels;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [processorLabel, setProcessorLabel] = useState(plan?.processorLabel ?? "");
  const [effectiveFrom, setEffectiveFrom] = useState(plan?.effectiveFrom ?? today);
  const [processedSalesShare, setProcessedSalesShare] = useState(
    plan ? percentFromBps(plan.processedSalesShareBps) : "",
  );
  const [processedTransactionShare, setProcessedTransactionShare] = useState(
    plan ? percentFromBps(plan.processedTransactionShareBps) : "",
  );
  const [averageTicket, setAverageTicket] = useState(dollarsFromCents(plan?.averageProcessedTicketCents ?? null));
  const [rules, setRules] = useState<RuleDraft[]>(() => initialRules(plan));
  const [error, setError] = useState<string | null>(null);
  const [savedSummary, setSavedSummary] = useState<typeof coverage | null>(null);

  function updateRule(id: string, field: keyof Omit<RuleDraft, "id">, value: string) {
    setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, [field]: value } : rule)));
  }

  function addRule() {
    setRules((current) => [
      ...current,
      {
        id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `rule-${Date.now()}`,
        label: "",
        percentageRate: "",
        fixedFee: "",
        salesMix: "",
        transactionMix: "",
      },
    ]);
  }

  function removeRule(id: string) {
    setRules((current) => (current.length > 1 ? current.filter((rule) => rule.id !== id) : current));
  }

  function save() {
    setError(null);
    setSavedSummary(null);

    const salesShareBps = bpsFromPercent(processedSalesShare);
    const transactionShareBps = bpsFromPercent(processedTransactionShare);
    const averageProcessedTicketCents = centsFromDollars(averageTicket, true);
    if (salesShareBps === null || transactionShareBps === null) {
      setError(labels.incompleteWarning);
      return;
    }

    const parsedRules = rules.map((rule) => {
      const percentageBps = bpsFromPercent(rule.percentageRate);
      const fixedParsed = rule.fixedFee.trim() ? Number(rule.fixedFee) : 0;
      const fixedFeeCents =
        Number.isFinite(fixedParsed) && fixedParsed >= 0 ? Math.round(fixedParsed * 100) : null;
      const salesMixBps = bpsFromPercent(rule.salesMix);
      const transactionMixBps = bpsFromPercent(rule.transactionMix);
      if (
        !rule.label.trim() ||
        percentageBps === null ||
        fixedFeeCents === null ||
        salesMixBps === null ||
        transactionMixBps === null
      ) {
        return null;
      }
      return {
        id: rule.id,
        label: rule.label.trim(),
        percentageBps,
        fixedFeeCents,
        salesMixBps,
        transactionMixBps,
      };
    });

    if (!processorLabel.trim() || parsedRules.some((rule) => !rule)) {
      setError(labels.incompleteWarning);
      return;
    }

    startTransition(async () => {
      const result = await saveOwnerProcessingFeeEstimatePlan({
        processorLabel: processorLabel.trim(),
        effectiveFrom,
        processedSalesShareBps: salesShareBps,
        processedTransactionShareBps: transactionShareBps,
        averageProcessedTicketCents,
        rules: parsedRules,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSavedSummary(result.summary);
      router.refresh();
    });
  }

  const shownCoverage = savedSummary ?? coverage;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-card-lg bg-good-tint p-4 text-sm leading-snug text-ink">
        {labels.assumptionBanner}
      </section>

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
          {labels.processor}
          <input
            value={processorLabel}
            onChange={(event) => setProcessorLabel(event.target.value)}
            maxLength={80}
            placeholder={labels.processorPlaceholder}
            className="min-h-12 rounded-xl border border-line px-3 text-base"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
          {labels.effectiveFrom}
          <input
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            className="min-h-12 rounded-xl border border-line px-3 text-base"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
            {labels.processedSalesShare}
            <div className="flex items-center gap-2">
              <input
                inputMode="decimal"
                value={processedSalesShare}
                onChange={(event) => setProcessedSalesShare(event.target.value)}
                className="min-h-12 min-w-0 flex-1 rounded-xl border border-line px-3 text-base"
              />
              <span className="font-bold text-ink-muted">%</span>
            </div>
            <span className="text-xs font-normal text-ink-muted">{labels.processedSalesShareHint}</span>
          </label>

          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
            {labels.processedTransactionShare}
            <div className="flex items-center gap-2">
              <input
                inputMode="decimal"
                value={processedTransactionShare}
                onChange={(event) => setProcessedTransactionShare(event.target.value)}
                className="min-h-12 min-w-0 flex-1 rounded-xl border border-line px-3 text-base"
              />
              <span className="font-bold text-ink-muted">%</span>
            </div>
            <span className="text-xs font-normal text-ink-muted">{labels.processedTransactionShareHint}</span>
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
          {labels.averageTicket}
          <div className="flex items-center gap-2">
            <span className="font-bold text-ink-muted">$</span>
            <input
              inputMode="decimal"
              value={averageTicket}
              onChange={(event) => setAverageTicket(event.target.value)}
              placeholder="12.00"
              className="min-h-12 min-w-0 flex-1 rounded-xl border border-line px-3 text-base"
            />
          </div>
          <span className="text-xs font-normal text-ink-muted">{labels.averageTicketHint}</span>
        </label>
      </section>

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
        <div>
          <h2 className="text-lg font-bold text-ink">{labels.rulesTitle}</h2>
          <p className="mt-1 text-sm leading-snug text-ink-muted">{labels.rulesHint}</p>
        </div>

        {rules.map((rule, index) => (
          <div key={rule.id} className="flex flex-col gap-3 rounded-2xl bg-paper p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold text-ink">#{index + 1}</span>
              {rules.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeRule(rule.id)}
                  className="min-h-10 rounded-full px-3 text-sm font-bold text-warn"
                >
                  {labels.remove}
                </button>
              )}
            </div>

            <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
              {labels.ruleLabel}
              <input
                value={rule.label}
                onChange={(event) => updateRule(rule.id, "label", event.target.value)}
                placeholder={labels.ruleLabelPlaceholder}
                className="min-h-11 rounded-lg border border-line bg-card px-3"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
                {labels.percentageRate}
                <div className="flex items-center gap-2">
                  <input
                    inputMode="decimal"
                    value={rule.percentageRate}
                    onChange={(event) => updateRule(rule.id, "percentageRate", event.target.value)}
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-card px-3"
                  />
                  <span className="font-bold text-ink-muted">%</span>
                </div>
              </label>

              <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
                {labels.fixedFee}
                <div className="flex items-center gap-2">
                  <span className="font-bold text-ink-muted">$</span>
                  <input
                    inputMode="decimal"
                    value={rule.fixedFee}
                    onChange={(event) => updateRule(rule.id, "fixedFee", event.target.value)}
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-card px-3"
                  />
                </div>
              </label>

              <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
                {labels.salesMix}
                <div className="flex items-center gap-2">
                  <input
                    inputMode="decimal"
                    value={rule.salesMix}
                    onChange={(event) => updateRule(rule.id, "salesMix", event.target.value)}
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-card px-3"
                  />
                  <span className="font-bold text-ink-muted">%</span>
                </div>
              </label>

              <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
                {labels.transactionMix}
                <div className="flex items-center gap-2">
                  <input
                    inputMode="decimal"
                    value={rule.transactionMix}
                    onChange={(event) => updateRule(rule.id, "transactionMix", event.target.value)}
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-line bg-card px-3"
                  />
                  <span className="font-bold text-ink-muted">%</span>
                </div>
              </label>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={addRule}
          className="min-h-12 rounded-full border border-line px-4 text-sm font-bold text-ink"
        >
          {labels.addRule}
        </button>
      </section>

      <section className="rounded-card-lg bg-card p-4">
        <h2 className="text-lg font-bold text-ink">{labels.coverageTitle}</h2>
        <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-xl bg-paper p-3">
            <span className="block text-ink-muted">{labels.coverageSalesDays}</span>
            <strong className="text-xl text-ink">{shownCoverage.salesDays}</strong>
          </div>
          <div className="rounded-xl bg-paper p-3">
            <span className="block text-ink-muted">{labels.coverageActual}</span>
            <strong className="text-xl text-good">{shownCoverage.actualDays}</strong>
          </div>
          <div className="rounded-xl bg-paper p-3">
            <span className="block text-ink-muted">{labels.coverageEstimated}</span>
            <strong className="text-xl text-ink">{shownCoverage.estimatedDays}</strong>
          </div>
          <div className="rounded-xl bg-paper p-3">
            <span className="block text-ink-muted">{labels.coverageMissing}</span>
            <strong className="text-xl text-warn">{shownCoverage.missingDays}</strong>
          </div>
        </div>
      </section>

      {error && <p className="rounded-xl bg-warn-tint p-3 text-sm font-semibold text-warn">{error}</p>}
      {savedSummary && <p className="rounded-xl bg-good-tint p-3 text-sm font-semibold text-good">{labels.saved}</p>}

      <button
        type="button"
        onClick={save}
        disabled={isPending}
        className="min-h-14 rounded-full bg-ink px-5 text-base font-bold text-paper disabled:opacity-40"
      >
        {isPending ? labels.saving : labels.save}
      </button>
    </div>
  );
}
