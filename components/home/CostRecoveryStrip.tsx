import { Link } from "@/i18n/navigation";
import FillIcon from "@/components/icons/FillIcon";
import type { BucketResult } from "@/lib/calc";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";

function shortDate(iso: string, locale: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {month:"short", day:"numeric", timeZone:"UTC"}).format(new Date(Date.UTC(year,month-1,day)));
}

export default function CostRecoveryStrip({
  buckets,
  labels,
  coveredLabel, locale = "en",
}: {
  buckets: BucketResult[];\n  locale?: string;
  labels: Record<string, string>;
  /** e.g. "{label} covered {date}" — built per-bucket below, this is just the template word. */
  coveredLabel: (label: string, date: string) => string;
}) {
  const caption = buckets
    .map((b) =>
      b.pctCovered >= 100
        ? coveredLabel(labels[b.code] ?? b.code, b.coveredOn ? shortDate(b.coveredOn, locale) : "")
        : `${labels[b.code] ?? b.code} ${new Intl.NumberFormat(locale,{maximumFractionDigits:0}).format(Math.round(b.pctCovered))}%`,
    )
    .join(" · ");

  return (
    <Link href="/money" className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
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
