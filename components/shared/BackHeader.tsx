import { ChevronLeft } from "lucide-react";
import { Link } from "@/i18n/navigation";

export default function BackHeader({
  title,
  subtitle,
  backHref = "/",
  backLabel,
}: {
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Link
        href={backHref}
        aria-label={backLabel}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-card text-ink rtl:rotate-180"
      >
        <ChevronLeft aria-hidden="true" size={22} />
      </Link>
      <div className="flex flex-col">
        <div className="text-xl font-bold text-ink">{title}</div>
        {subtitle && <div className="text-sm font-medium text-ink-muted">{subtitle}</div>}
      </div>
    </div>
  );
}
