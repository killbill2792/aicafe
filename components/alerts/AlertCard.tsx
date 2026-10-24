import { ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import PlainIcon from "@/components/icons/PlainIcon";
import { formatCents } from "@/lib/calc/money";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";

export default function AlertCard({
  href,
  icon,
  title,
  subtitle,
  impactCents,
  locale,
  reviewLabel,
}: {
  href: string;
  icon: string;
  title: string;
  subtitle: string;
  impactCents: number | null;
  locale: string;
  reviewLabel?: string;
}) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-[20px] bg-card p-4 text-ink no-underline">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-warn-tint text-warn">
        <PlainIcon code={icon as ExpenseIconCode} size={22} color="currentColor" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-start">
        <span className="text-[17px] font-bold">{title}</span>
        <span className="text-sm text-ink-muted">{subtitle}</span>
        {reviewLabel && <span className="mt-1 text-base font-semibold text-accent-text">{reviewLabel}</span>}
      </span>
      {impactCents !== null ? (
        <span className="shrink-0 text-end text-lg font-bold text-warn">
          {formatCents(impactCents, locale)}
        </span>
      ) : (
        <ChevronRight aria-hidden="true" size={18} className="text-ink-muted rtl:rotate-180" />
      )}
    </Link>
  );
}
