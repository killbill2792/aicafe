import { ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import Money from "@/components/shared/Money";
import { formatCents } from "@/lib/calc";

function CardShell({ href, step, title, children }: { href: string; step: number; title: string; children: React.ReactNode }) {
  const surfaces: Record<number, string> = {
    1: "border border-[#D7C8B5] bg-[#EFE5D7]",
    2: "border border-[#B9CBDB] bg-[#E8EFF5]",
    3: "border border-[#D9C2A9] bg-[#F3E9DD]",
    4: "border border-line bg-card",
    5: "border border-[#E6BEA7] bg-warn-tint",
  };
  return (
    <Link href={href} className={`flex min-h-12 flex-col gap-3.5 rounded-card-lg p-[18px] text-ink no-underline ${surfaces[step] ?? "bg-card"}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-xl bg-ink text-xs font-extrabold text-paper">{step}</span>
          <span className="text-lg font-bold">{title}</span>
        </div>
        <ChevronRight aria-hidden="true" size={20} className="text-ink-muted rtl:rotate-180" />
      </div>
      {children}
    </Link>
  );
}

export function ProfitCostsCard({
  step,
  title,
  ingredientsCents,
  staffCents,
  runningCents,
  profitCents,
  labels,
}: {
  step: number;
  title: string;
  ingredientsCents: number;
  staffCents: number;
  runningCents: number;
  profitCents: number;
  labels: { ingredients: string; staff: string; running: string; profit: string };
}) {
  const total = ingredientsCents + staffCents + runningCents + Math.max(0, profitCents);
  const pct = (n: number) => (total === 0 ? 0 : (n / total) * 100);
  const segments = [
    { key: "ingredients", cents: ingredientsCents, color: "bg-ingredients", label: labels.ingredients },
    { key: "staff", cents: staffCents, color: "bg-staff", label: labels.staff },
    { key: "running", cents: runningCents, color: "bg-running", label: labels.running },
    { key: "profit", cents: Math.max(0, profitCents), color: "bg-good", label: labels.profit },
  ];

  return (
    <CardShell href="/money" step={step} title={title}>
      <div className="flex h-9 gap-[3px] overflow-hidden rounded-[10px]">
        {segments.map((s) => (
          <div key={s.key} className={s.color} style={{ width: `${pct(s.cents)}%` }} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        {segments.map((s) => (
          <div key={s.key} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={`h-3 w-3 shrink-0 rounded-[3px] ${s.color}`} />
            <span className="flex-1">{s.label}</span>
            <b className="break-words">
              <Money cents={s.cents} />
            </b>
          </div>
        ))}
      </div>
    </CardShell>
  );
}

export function MenuTeaserCard({
  step,
  title,
  bestLabel,
  worstLabel,
  best,
  worst,
}: {
  step: number;
  title: string;
  bestLabel: string;
  worstLabel: string;
  best: { name: string; keptCents: number } | null;
  worst: { name: string; keptCents: number } | null;
}) {
  return (
    <CardShell href="/menu" step={step} title={title}>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-0.5 rounded-2xl bg-good-tint p-3">
          <span className="text-xs font-bold text-[#1E4D37]">{bestLabel}</span>
          {best && (
            <>
              <span className="text-base font-bold">{best.name}</span>
              <span className="text-sm text-[#1E4D37]">{formatCents(best.keptCents)}</span>
            </>
          )}
        </div>
        <div className="flex flex-col gap-0.5 rounded-2xl bg-warn-tint p-3">
          <span className="text-xs font-bold text-[#6E2A07]">{worstLabel}</span>
          {worst && (
            <>
              <span className="text-base font-bold">{worst.name}</span>
              <span className="text-sm text-[#6E2A07]">{formatCents(worst.keptCents)}</span>
            </>
          )}
        </div>
      </div>
    </CardShell>
  );
}

export function BreakEvenTeaserCard({
  step,
  title,
  neededLabel,
  averageLabel,
  progressPct,
}: {
  step: number;
  title: string;
  neededLabel: string;
  averageLabel: string;
  progressPct: number;
}) {
  return (
    <CardShell href="/more/break-even" step={step} title={title}>
      <div className="relative h-4 rounded-lg bg-good-tint">
        <div className="h-4 rounded-lg bg-good" style={{ width: "100%" }} />
        <div className="absolute -top-[5px] h-[26px] w-[3px] rounded bg-ink" style={{ insetInlineStart: `${Math.min(100, progressPct)}%` }} />
      </div>
      <div className="flex justify-between text-sm font-medium text-ink-muted">
        <span>{neededLabel}</span>
        <span className="font-bold text-good">{averageLabel}</span>
      </div>
    </CardShell>
  );
}

export function StaffTeaserCard({
  step,
  title,
  perMinuteCents,
  perMinuteLabel,
}: {
  step: number;
  title: string;
  perMinuteCents: number;
  perMinuteLabel: string;
}) {
  return (
    <CardShell href="/staff" step={step} title={title}>
      <div className="flex flex-col gap-0.5">
        <span className="text-xl font-extrabold text-staff">{formatCents(perMinuteCents)}</span>
        <span className="text-xs text-ink-muted">{perMinuteLabel}</span>
      </div>
    </CardShell>
  );
}

export function AlertsTeaserCard({
  step,
  title,
  countLabel,
  leakingCents,
  leakingLabel,
}: {
  step: number;
  title: string;
  countLabel: string;
  leakingCents: number;
  leakingLabel: string;
}) {
  return (
    <CardShell href="/more/alerts" step={step} title={`${title} · ${countLabel}`}>
      <div className="flex flex-col gap-0.5">
        <span className="text-2xl font-extrabold text-warn">{formatCents(leakingCents)}</span>
        <span className="text-xs text-ink-muted">{leakingLabel}</span>
      </div>
    </CardShell>
  );
}
