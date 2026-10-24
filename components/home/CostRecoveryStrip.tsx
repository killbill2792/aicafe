import { Link } from "@/i18n/navigation";
import type { BucketResult } from "@/lib/calc";

function shortDate(iso: string, locale: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {month:"short", day:"numeric", timeZone:"UTC"}).format(new Date(Date.UTC(year,month-1,day)));
}

export default function CostRecoveryStrip({
  buckets,
  labels,
  coveredLabel, locale = "en",
}: {
  buckets: BucketResult[];
  locale?: string;
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
    <Link href="/money" className="mt-3 flex min-h-12 items-center border-t border-line pt-3 text-start no-underline">
      <p className="text-[17px] font-semibold leading-snug text-ink-muted">{caption}</p>
    </Link>
  );
}
