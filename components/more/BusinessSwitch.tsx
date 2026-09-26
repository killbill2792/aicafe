"use client";

import { useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { setActiveBusinessCookie } from "@/lib/actions/setActiveBusiness";
import { DEMO_BUSINESS_ID } from "@/lib/constants";

export default function BusinessSwitch({
  activeBusinessId,
  ownBusinessId,
  labels,
}: {
  activeBusinessId: string;
  ownBusinessId: string | null;
  labels: { title: string; demo: string; mine: string; noOwnBusiness: string };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const isDemo = activeBusinessId === DEMO_BUSINESS_ID;

  function switchTo(businessId: string) {
    startTransition(async () => {
      const result = await setActiveBusinessCookie(businessId);
      if (result.ok) router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-card-lg bg-card p-4">
      <span className="text-base font-bold">{labels.title}</span>
      <div className="flex gap-1 rounded-3xl bg-[#EDE5D9] p-1">
        <button
          type="button"
          disabled={isPending}
          onClick={() => switchTo(DEMO_BUSINESS_ID)}
          aria-pressed={isDemo}
          className={`h-11 flex-1 rounded-3xl text-[15px] font-semibold ${isDemo ? "bg-card font-bold text-ink shadow-sm" : "text-[#4A3A2E]"}`}
        >
          {labels.demo}
        </button>
        <button
          type="button"
          disabled={isPending || !ownBusinessId}
          onClick={() => ownBusinessId && switchTo(ownBusinessId)}
          aria-pressed={!isDemo}
          className={`h-11 flex-1 rounded-3xl text-[15px] font-semibold disabled:opacity-40 ${!isDemo ? "bg-card font-bold text-ink shadow-sm" : "text-[#4A3A2E]"}`}
        >
          {labels.mine}
        </button>
      </div>
      {!ownBusinessId && <span className="text-xs text-ink-muted">{labels.noOwnBusiness}</span>}
    </div>
  );
}
