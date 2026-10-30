import type { Period } from "@/lib/viewmodels/period";

export function periodFromUrl(value: string | null, fallback: Period = "today"): Period {
  return value === "today" || value === "week" || value === "month" ? value : fallback;
}

/** Keep the thread, experiment, and any other query state when changing only the period. */
export function periodHref(pathname: string, search: string, period: Period): string {
  const params = new URLSearchParams(search);
  params.set("period", period);
  return `${pathname}?${params.toString()}`;
}

/** A replace should normally be the only navigation. Recover only if its committed server
 * period disagrees with the URL; a refresh during the pending transition races the replace. */
export function needsPeriodRecovery(
  serverPeriod: Period,
  urlPeriod: Period,
  navigationPending: boolean,
  alreadyTried: boolean,
): boolean {
  return !navigationPending && serverPeriod !== urlPeriod && !alreadyTried;
}

/** An interrupted/stale navigation may be retried without trapping every period button. */
export function periodTapAction(
  target: Period,
  serverPeriod: Period,
  urlPeriod: Period,
  navigating: boolean,
): "none" | "replace" | "refresh" {
  if (navigating || (target === serverPeriod && target === urlPeriod)) return "none";
  return target === urlPeriod ? "refresh" : "replace";
}
