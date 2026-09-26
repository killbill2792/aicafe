import { ChevronDown, ChevronUp } from "lucide-react";
import { Link } from "@/i18n/navigation";
import PlainIcon from "@/components/icons/PlainIcon";
import { moveRecoveryBucket } from "@/lib/actions/recoveryOrder";
import type { ExpenseCategoryCode } from "@/lib/constants";

export default function RecoveryOrderStep({
  order,
  categoryLabels,
  labels,
}: {
  order: ExpenseCategoryCode[];
  categoryLabels: Record<ExpenseCategoryCode, string>;
  labels: { finish: string };
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-card-lg bg-card px-4">
        {order.map((code, i) => (
          <div key={code} className="flex items-center gap-3 border-b border-[#EFE7DB] py-3 last:border-b-0">
            <PlainIcon code={code} size={28} />
            <span className="flex-1 text-base font-semibold">{categoryLabels[code]}</span>
            <div className="flex flex-col">
              <form action={moveRecoveryBucket.bind(null, "up", code)}>
                <button type="submit" disabled={i === 0} aria-label={`Move ${categoryLabels[code]} earlier`} className="flex h-6 w-9 items-center justify-center text-[#B7A994] disabled:opacity-30">
                  <ChevronUp size={18} aria-hidden="true" />
                </button>
              </form>
              <form action={moveRecoveryBucket.bind(null, "down", code)}>
                <button type="submit" disabled={i === order.length - 1} aria-label={`Move ${categoryLabels[code]} later`} className="flex h-6 w-9 items-center justify-center text-[#B7A994] disabled:opacity-30">
                  <ChevronDown size={18} aria-hidden="true" />
                </button>
              </form>
            </div>
          </div>
        ))}
      </div>
      <Link href="/" className="flex h-14 items-center justify-center rounded-full bg-ink text-lg font-bold text-paper">
        {labels.finish}
      </Link>
    </div>
  );
}
