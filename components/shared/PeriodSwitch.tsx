"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import type { Period } from "@/lib/viewmodels/period";
import { needsPeriodRecovery, periodFromUrl, periodHref, periodTapAction } from "./periodNavigation";

const PERIODS: Period[] = ["today", "week", "month"];

export default function PeriodSwitch({ current, defaultPeriod = "today" }: { current: Period; defaultPeriod?: Period }) {
  const t = useTranslations("Common");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pendingPeriod, setPendingPeriod] = useState<Period | null>(null);
  const [isNavigating, startNavigation] = useTransition();
  const recoveredUrl = useRef<string | null>(null);

  const urlPeriod = periodFromUrl(searchParams.get("period"), defaultPeriod);
  const hrefKey = `${pathname}?${searchParams.toString()}`;
  const waitingForData = pendingPeriod !== null && pendingPeriod !== current &&
    (isNavigating || urlPeriod === pendingPeriod);
  const busy = isNavigating || waitingForData;

  useEffect(() => {
    if (current === urlPeriod) {
      recoveredUrl.current = null;
      return;
    }
    // Next 16 can commit the URL while reusing the previous period's RSC render.
    // Do not refresh preemptively: the common case now makes one data navigation,
    // while the documented stale-render case still forces a fresh server read.
    if (!needsPeriodRecovery(current, urlPeriod, isNavigating, recoveredUrl.current === hrefKey)) return;
    recoveredUrl.current = hrefKey;
    startNavigation(() => router.refresh());
  }, [current, urlPeriod, isNavigating, hrefKey, router, startNavigation]);

  function setPeriod(period: Period) {
    // Only active requests block taps. If a refresh failed to reconcile a stale URL,
    // let the owner retry that period or return to the displayed period.
    const action = periodTapAction(period, current, urlPeriod, isNavigating);
    if (action === "none") return;
    recoveredUrl.current = action === "refresh" ? hrefKey : null;
    setPendingPeriod(period);
    startNavigation(() => {
      if (action === "refresh") router.refresh();
      else router.replace(periodHref(pathname, searchParams.toString(), period), { scroll: false });
    });
  }

  return (
    <div role="group" aria-label={t("periodSwitchLabel")} aria-busy={busy}
      className="flex gap-1.5 rounded-3xl bg-surface2 p-1">
      {PERIODS.map((period) => {
        const active = period === current;
        const waiting = busy && pendingPeriod === period && period !== current;
        return (
          <button
            key={period}
            data-perf-nav="period" data-perf-value={period}
            type="button"
            aria-pressed={active}
            aria-label={waiting ? `${t(period)}…` : t(period)}
            disabled={isNavigating}
            onClick={() => setPeriod(period)}
            className={`min-h-12 flex-1 rounded-3xl text-[15px] font-semibold transition-colors ${
              waiting ? "bg-card text-ink ring-2 ring-accent-text" :
              active ? "bg-card font-bold text-ink shadow-sm" : "bg-transparent text-muted"
            }`}
          >
            {t(period)}
            {waiting && <span aria-hidden="true" className="ms-2 inline-block size-3 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin" />}
          </button>
        );
      })}
    </div>
  );
}
