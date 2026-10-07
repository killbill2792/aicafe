"use client";

import { useState, useTransition } from "react";
import { Info, Upload } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import { saveOwnerProcessingFeeEstimatePlan } from "@/lib/actions/processingFeeEstimate";
import { formatCents } from "@/lib/calc";
import type { OwnerConfirmedProcessingFeePlan } from "@/lib/pos/processingFeeEstimate";

type Labels = {
  assumptionBanner: string;
  automaticTitle: string;
  connectedSource: string;
  actualCoverage: string;
  completeActualCoverage: string;
  missingCoverage: string;
  actualFirstNote: string;
  uploadActual: string;
  estimateTitle: string;
  estimateIntro: string;
  processor: string;
  processorPlaceholder: string;
  processorHelp: string;
  effectiveFrom: string;
  effectiveFromHelp: string;
  processedSalesShare: string;
  processedSalesShareHint: string;
  processedSalesShareHelp: string;
  processedTransactionShare: string;
  processedTransactionShareHint: string;
  processedTransactionShareHelp: string;
  averageTicket: string;
  averageTicketHint: string;
  averageTicketHelp: string;
  orderCountsAutomatic: string;
  rulesTitle: string;
  rulesHint: string;
  ruleLabel: string;
  ruleLabelPlaceholder: string;
  percentageRate: string;
  percentageRateHelp: string;
  fixedFee: string;
  fixedFeeHelp: string;
  salesMix: string;
  salesMixHelp: string;
  transactionMix: string;
  transactionMixHelp: string;
  standardRate: string;
  advanced: string;
  advancedHint: string;
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

type SourceSummary = {
  connectedProvider: string | null;
  actualProviders: string[];
  actualFeeCents: number;
  trustedOrderDays: number;
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
    return [{ id: "rule-1", label: "", percentageRate: "", fixedFee: "", salesMix: "100", transactionMix: "100" }];
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

function providerLabel(provider: string | null): string {
  if (!provider) return "";
  if (provider.toLowerCase() === "square") return "Square";
  if (provider.toLowerCase() === "toast") return "Toast";
  if (provider.toLowerCase() === "clover") return "Clover";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function Help({ label, children }: { label: string; children: string }) {
  return (
    <details className="relative inline-block">
      <summary
        aria-label={label}
        className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-full text-ink-muted hover:bg-paper [&::-webkit-details-marker]:hidden"
      >
        <Info aria-hidden="true" size={17} />
      </summary>
      <p className="absolute end-0 z-20 mt-1 w-64 rounded-2xl border border-line bg-card p-3 text-xs font-normal leading-relaxed text-ink shadow-lg">
        {children}
      </p>
    </details>
  );
}

function FieldTitle({ children, help, helpLabel }: { children: string; help: string; helpLabel: string }) {
  return (
    <span className="flex items-center justify-between gap-2">
      <span>{children}</span>
      <Help label={helpLabel}>{help}</Help>
    </span>
  );
}

export default function ProcessingFeeEstimateForm({
  plan,
  today,
  coverage,
  sourceSummary,
  labels,
}: {
  plan: OwnerConfirmedProcessingFeePlan | null;
  today: string;
  coverage: { salesDays: number; actualDays: number; estimatedDays: number; missingDays: number };
  sourceSummary: SourceSummary;
  labels: Labels;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [processorLabel, setProcessorLabel] = useState(plan?.processorLabel ?? providerLabel(sourceSummary.connectedProvider));
  const [effectiveFrom, setEffectiveFrom] = useState(plan?.effectiveFrom ?? today);
  const [processedSalesShare, setProcessedSalesShare] = useState(plan ? percentFromBps(plan.processedSalesShareBps) : "");
  const [processedTransactionShare, setProcessedTransactionShare] = useState(
    plan ? percentFromBps(plan.processedTransactionShareBps) : "",
  );
  const [averageTicket, setAverageTicket] = useState(dollarsFromCents(plan?.averageProcessedTicketCents ?? null));
  const [rules, setRules] = useState<RuleDraft[]>(() => initialRules(plan));
  const [advanced, setAdvanced] = useState(
    Boolean(plan && (plan.rules.length > 1 || plan.processedSalesShareBps !== plan.processedTransactionShareBps)),
  );
  const [error, setError] = useState<string | null>(null);
  const [savedSummary, setSavedSummary] = useState<typeof coverage | null>(null);

  function updateRule(id: string, field: keyof Omit<RuleDraft, "id">, value: string) {
    setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, [field]: value } : rule)));
  }

  function addRule() {
    setAdvanced(true);
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
    const transactionShareBps = advanced ? bpsFromPercent(processedTransactionShare) : salesShareBps;
    if (salesShareBps === null || transactionShareBps === null) {
      setError(labels.incompleteWarning);
      return;
    }

    const ruleDrafts = advanced
      ? rules
      : [{
          ...rules[0],
          label: labels.standardRate,
          salesMix: "100",
          transactionMix: "100",
        }];

    const parsedRules = ruleDrafts.map((rule) => {
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

    const hasFixedFee = parsedRules.some((rule) => (rule?.fixedFeeCents ?? 0) > 0);
    const needsAverageTicket = hasFixedFee && sourceSummary.trustedOrderDays < coverage.salesDays;
    const averageProcessedTicketCents = needsAverageTicket ? centsFromDollars(averageTicket, true) : null;
    if (needsAverageTicket && averageProcessedTicketCents === null) {
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
  const connected = providerLabel(sourceSummary.connectedProvider);
  const firstRule = rules[0];
  const firstFixedFee = Number(firstRule?.fixedFee || 0);
  const needsAverageTicket = firstFixedFee > 0 && sourceSummary.trustedOrderDays < coverage.salesDays;
  const completeActualCoverage =
    coverage.salesDays > 0 && coverage.actualDays === coverage.salesDays && coverage.missingDays === 0;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-card-lg bg-good-tint p-4 text-sm leading-snug text-ink">
        {labels.assumptionBanner}
      </section>

      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
        <div>
          <h2 className="text-lg font-bold text-ink">{labels.automaticTitle}</h2>
          <p className="mt-1 text-sm leading-snug text-ink-muted">{labels.actualFirstNote}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {connected && (
            <span className="rounded-full bg-good-tint px-3 py-1.5 text-xs font-bold text-good">
              {labels.connectedSource.replace("{provider}", connected)}
            </span>
          )}
          <span className="rounded-full bg-paper px-3 py-1.5 text-xs font-bold text-ink">
            {labels.actualCoverage
              .replace("{actual}", String(shownCoverage.actualDays))
              .replace("{sales}", String(shownCoverage.salesDays))}
          </span>
        </div>

        {completeActualCoverage ? (
          <p className="rounded-xl bg-good-tint p-3 text-sm font-semibold text-good">{labels.completeActualCoverage}</p>
        ) : shownCoverage.missingDays > 0 ? (
          <p className="rounded-xl bg-warn-tint p-3 text-sm font-semibold text-warn">
            {labels.missingCoverage.replace("{count}", String(shownCoverage.missingDays))}
          </p>
        ) : null}

        {sourceSummary.actualFeeCents > 0 && (
          <p className="text-sm text-ink-muted">
            {formatCents(sourceSummary.actualFeeCents)} · {labels.coverageActual}
          </p>
        )}

        <Link
          href="/more/uploads/processing-fees"
          className="flex min-h-12 items-center justify-center gap-2 rounded-full border border-line px-4 text-sm font-bold text-ink no-underline"
        >
          <Upload aria-hidden="true" size={18} />
          {labels.uploadActual}
        </Link>
      </section>

      <section className="flex flex-col gap-4 rounded-card-lg bg-card p-4">
        <div>
          <h2 className="text-lg font-bold text-ink">{labels.estimateTitle}</h2>
          <p className="mt-1 text-sm leading-snug text-ink-muted">{labels.estimateIntro}</p>
        </div>

        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
          <FieldTitle help={labels.processorHelp} helpLabel={`${labels.processor} info`}>{labels.processor}</FieldTitle>
          <input
            value={processorLabel}
            onChange={(event) => setProcessorLabel(event.target.value)}
            maxLength={80}
            placeholder={labels.processorPlaceholder}
            className="min-h-12 rounded-xl border border-line px-3 text-base"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
          <FieldTitle help={labels.effectiveFromHelp} helpLabel={`${labels.effectiveFrom} info`}>{labels.effectiveFrom}</FieldTitle>
          <input
            type="date"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
            className="min-h-12 rounded-xl border border-line px-3 text-base"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
          <FieldTitle help={labels.processedSalesShareHelp} helpLabel={`${labels.processedSalesShare} info`}>
            {labels.processedSalesShare}
          </FieldTitle>
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

        <div className="rounded-2xl bg-paper p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
              <FieldTitle help={labels.percentageRateHelp} helpLabel={`${labels.percentageRate} info`}>
                {labels.percentageRate}
              </FieldTitle>
              <div className="flex items-center gap-2">
                <input
                  inputMode="decimal"
                  value={firstRule?.percentageRate ?? ""}
                  onChange={(event) => updateRule(firstRule.id, "percentageRate", event.target.value)}
                  className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-card px-3 text-base"
                />
                <span className="font-bold text-ink-muted">%</span>
              </div>
            </label>

            <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
              <FieldTitle help={labels.fixedFeeHelp} helpLabel={`${labels.fixedFee} info`}>{labels.fixedFee}</FieldTitle>
              <div className="flex items-center gap-2">
                <span className="font-bold text-ink-muted">$</span>
                <input
                  inputMode="decimal"
                  value={firstRule?.fixedFee ?? ""}
                  onChange={(event) => updateRule(firstRule.id, "fixedFee", event.target.value)}
                  className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-card px-3 text-base"
                />
              </div>
            </label>
          </div>
        </div>

        {firstFixedFee > 0 && sourceSummary.trustedOrderDays > 0 && !needsAverageTicket && (
          <p className="rounded-xl bg-good-tint p-3 text-sm font-semibold text-good">
            {labels.orderCountsAutomatic.replace("{count}", String(sourceSummary.trustedOrderDays))}
          </p>
        )}

        {needsAverageTicket && !advanced && (
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
            <FieldTitle help={labels.averageTicketHelp} helpLabel={`${labels.averageTicket} info`}>{labels.averageTicket}</FieldTitle>
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
        )}

        <button
          type="button"
          onClick={() => setAdvanced((value) => !value)}
          aria-expanded={advanced}
          className="min-h-12 rounded-full border border-line px-4 text-sm font-bold text-ink"
        >
          {labels.advanced}
        </button>
        <p className="-mt-2 text-xs leading-snug text-ink-muted">{labels.advancedHint}</p>
      </section>

      {advanced && (
        <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
          <div>
            <h2 className="text-lg font-bold text-ink">{labels.rulesTitle}</h2>
            <p className="mt-1 text-sm leading-snug text-ink-muted">{labels.rulesHint}</p>
          </div>

          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
            <FieldTitle help={labels.processedTransactionShareHelp} helpLabel={`${labels.processedTransactionShare} info`}>
              {labels.processedTransactionShare}
            </FieldTitle>
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

          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">
            <FieldTitle help={labels.averageTicketHelp} helpLabel={`${labels.averageTicket} info`}>{labels.averageTicket}</FieldTitle>
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

          {rules.map((rule, index) => (
            <div key={rule.id} className="flex flex-col gap-3 rounded-2xl bg-paper p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-ink">#{index + 1}</span>
                {rules.length > 1 && (
                  <button type="button" onClick={() => removeRule(rule.id)} className="min-h-10 rounded-full px-3 text-sm font-bold text-warn">
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
                  <FieldTitle help={labels.percentageRateHelp} helpLabel={`${labels.percentageRate} info`}>
                    {labels.percentageRate}
                  </FieldTitle>
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
                  <FieldTitle help={labels.fixedFeeHelp} helpLabel={`${labels.fixedFee} info`}>{labels.fixedFee}</FieldTitle>
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
                  <FieldTitle help={labels.salesMixHelp} helpLabel={`${labels.salesMix} info`}>{labels.salesMix}</FieldTitle>
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
                  <FieldTitle help={labels.transactionMixHelp} helpLabel={`${labels.transactionMix} info`}>{labels.transactionMix}</FieldTitle>
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

          <button type="button" onClick={addRule} className="min-h-12 rounded-full border border-line px-4 text-sm font-bold text-ink">
            {labels.addRule}
          </button>
        </section>
      )}

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
