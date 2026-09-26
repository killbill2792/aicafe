import { Link } from "@/i18n/navigation";
import FillIcon from "@/components/icons/FillIcon";
import type { BucketResult } from "@/lib/calc";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";

function shortDate(iso: string) {
  const [, month, day] = iso.split("-");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[Number(month) - 1]} ${Number(day)}`;
}

export default function CostRecoveryStrip({
  buckets,
  labels,
  coveredLabel,
}: {
  buckets: BucketResult[];
  labels: Record<string, string>;
  /** e.g. "{label} covered {date}" — built per-bucket below, this is just the template word. */
  coveredLabel: (label: string, date: string) => string;
}) {
  const caption = buckets
    .map((b) =>
      b.pctCovered >= 100
        ? coveredLabel(labels[b.code] ?? b.code, b.coveredOn ? shortDate(b.coveredOn) : "")
        : `${labels[b.code] ?? b.code} ${Math.round(b.pctCovered)}%`,
    )
    .join(" · ");

  return (
    <Link href="/money" className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
      <div className="flex justify-between gap-2 overflow-x-auto">
        {buckets.map((b) => (
          <FillIcon
            key={b.code}
            code={b.code as ExpenseIconCode}
            pctCovered={b.pctCovered}
            covered={b.pctCovered >= 100}
            size={44}
            label={`${labels[b.code] ?? b.code} ${Math.round(b.pctCovered)}%`}
          />
        ))}
      </div>
      <p className="text-[13px] font-semibold leading-snug text-ink-muted">{caption}</p>
    </Link>
  );
}
