import { formatCents } from "@/lib/calc";

/** Money is always formatted in Western digits with $, in every language (docs/02-design-system.md). */
export default function Money({ cents, className }: { cents: number; className?: string }) {
  return <span className={className}>{formatCents(cents)}</span>;
}
