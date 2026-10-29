import { formatCents } from "@/lib/calc";

/** Format an amount using the café currency, never an implicit USD. */
export default function Money({ cents, className, currency }: { cents: number; className?: string; currency?: string | null }) {
  return <span className={className}>{formatCents(cents, undefined, currency)}</span>;
}
