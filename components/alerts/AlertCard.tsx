import { ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import PlainIcon from "@/components/icons/PlainIcon";
import Money from "@/components/shared/Money";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";

export default function AlertCard({
  href,
  icon,
  title,
  subtitle,
  impactCents,
}: {
  href: string;
  icon: string;
  title: string;
  subtitle: string;
  impactCents: number | null;
}) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-[20px] bg-card p-4 text-ink no-underline">
      <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-warn-tint text-warn">
        <PlainIcon code={icon as ExpenseIconCode} size={22} color="#B4460E" />
      </span>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-[17px] font-bold">{title}</span>
        <span className="text-sm text-ink-muted">{subtitle}</span>
      </span>
      {impactCents !== null ? (
        <span className="text-lg font-bold text-warn">
          <Money cents={impactCents} />
        </span>
      ) : (
        <ChevronRight aria-hidden="true" size={18} className="text-ink-muted rtl:rotate-180" />
      )}
    </Link>
  );
}
