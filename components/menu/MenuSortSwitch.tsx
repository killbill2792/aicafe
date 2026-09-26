"use client";

import { useSearchParams } from "next/navigation";
import { usePathname, useRouter } from "@/i18n/navigation";

export default function MenuSortSwitch({
  current,
  perCupLabel,
  totalLabel,
}: {
  current: "perCup" | "total";
  perCupLabel: string;
  totalLabel: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setSort(sort: "perCup" | "total") {
    const params = new URLSearchParams(searchParams.toString());
    params.set("sort", sort);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <select
      aria-label={perCupLabel}
      value={current}
      onChange={(e) => setSort(e.target.value === "total" ? "total" : "perCup")}
      className="rounded-full border border-line bg-card px-2.5 py-1 text-[13px] font-semibold text-ink-muted"
    >
      <option value="perCup">{perCupLabel}</option>
      <option value="total">{totalLabel}</option>
    </select>
  );
}
