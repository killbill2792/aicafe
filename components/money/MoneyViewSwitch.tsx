"use client";

import { useSearchParams } from "next/navigation";
import { usePathname, useRouter } from "@/i18n/navigation";

export default function MoneyViewSwitch({
  current,
  recoveryLabel,
  profitLabel,
}: {
  current: "recovery" | "profit";
  recoveryLabel: string;
  profitLabel: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function setView(view: "recovery" | "profit") {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", view);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <div role="group" aria-label="Money view" className="flex gap-1 rounded-3xl bg-[#EDE5D9] p-1">
      {(["recovery", "profit"] as const).map((view) => (
        <button
          key={view}
          type="button"
          aria-pressed={current === view}
          onClick={() => setView(view)}
          className={`h-11 flex-1 rounded-3xl text-[16px] font-semibold ${
            current === view ? "bg-card font-extrabold text-ink shadow-sm" : "bg-transparent text-[#4A3A2E]"
          }`}
        >
          {view === "recovery" ? recoveryLabel : profitLabel}
        </button>
      ))}
    </div>
  );
}
