"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import type { Period } from "@/lib/viewmodels/period";

const PERIODS: Period[] = ["today", "week", "month"];

export default function PeriodSwitch({ current }: { current: Period }) {
  const t = useTranslations("Common");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setPeriod(period: Period) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("period", period);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <div role="group" aria-label={t("periodSwitchLabel")} className="flex gap-1.5 rounded-3xl bg-[#EDE5D9] p-1">
      {PERIODS.map((period) => {
        const active = period === current;
        return (
          <button
            key={period}
            type="button"
            aria-pressed={active}
            onClick={() => setPeriod(period)}
            className={`h-10 flex-1 rounded-3xl text-[15px] font-semibold transition-colors ${
              active ? "bg-card font-bold text-ink shadow-sm" : "bg-transparent text-[#4A3A2E]"
            }`}
          >
            {t(period)}
          </button>
        );
      })}
    </div>
  );
}
