import { Link } from "@/i18n/navigation";
import type { BucketResult } from "@/lib/calc";

function shortDate(iso: string, locale: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {month:"short", day:"numeric", timeZone:"UTC"})
    .format(new Date(Date.UTC(year,month-1,day)));
}

/** One recovery status, not a second dashboard covering every cost category. */
export default function CostRecoveryStrip({
  buckets, labels, coveredLabel, locale = "en", emptyLabel,
}: {
  buckets: BucketResult[];
  labels: Record<string, string>;
  coveredLabel: (label: string, date: string) => string;
  locale?: string;
  emptyLabel: string;
}) {
  const current = buckets.find(bucket => bucket.pctCovered < 100) ?? buckets[buckets.length-1];
  const caption = !current ? emptyLabel :
    current.pctCovered >= 100 && current.coveredOn
      ? coveredLabel(labels[current.code] ?? current.code, shortDate(current.coveredOn, locale))
      : `${labels[current.code] ?? current.code} ${new Intl.NumberFormat(locale,{maximumFractionDigits:0}).format(Math.round(current.pctCovered))}%`;
  return (
    <Link href="/money" className="mt-3 flex min-h-12 items-center border-t border-line pt-3 text-start no-underline">
      <p className="truncate text-[17px] font-semibold text-ink-muted" title={caption}>{caption}</p>
    </Link>
  );
}
