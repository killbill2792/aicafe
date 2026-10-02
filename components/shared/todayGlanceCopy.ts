import { formatCents } from "@/lib/calc";
import type { TodayGlanceViewModel } from "@/lib/viewmodels/todayGlance";
import type { ExpenseIconCode } from "@/components/icons/ExpenseIconDefs";

type Translator = (key: string, values?: Record<string, string | number>) => string;

/**
 * Turns a `TodayGlanceViewModel`'s bucket state into the one sentence + (at most) one icon the
 * "Today at a glance" card shows — kept out of `lib/viewmodels` because it calls `t()` directly;
 * the viewmodel itself stays translation-agnostic and unit-testable. Home and Money share this so
 * the wording can't drift between the two places the card appears.
 */
export function todayGlanceCopy(
  glance: TodayGlanceViewModel,
  t: Translator,
  tCommon: Translator,
  labelFor: (bucketCode: string) => string,
): { caption: string; icon: { code: ExpenseIconCode; pctCovered: number } | null } {
  const state = glance.bucketState;

  if (state.kind === "noSalesYet") return { caption: tCommon("noSalesToday"), icon: null };
  if (state.kind === "noProgressToday") return { caption: t("glanceNoProgressToday"), icon: null };
  if (state.kind === "noBills") return { caption: t("glanceNoBills"), icon: null };

  if (state.kind === "allYours") {
    return {
      caption: state.amountCents > 0 ? t("glanceAllYours", { amount: formatCents(state.amountCents) }) : t("glanceAllYoursNoSales"),
      icon: null,
    };
  }

  if (state.kind === "crossed") {
    const finished = labelFor(state.finishedBucketCode);
    if (state.startedBucketCode === "yours") {
      return { caption: t("glanceCrossedToYours", { finished }), icon: null };
    }
    return {
      caption: t("glanceCrossed", { finished, started: labelFor(state.startedBucketCode) }),
      icon: { code: state.startedBucketCode as ExpenseIconCode, pctCovered: 0 },
    };
  }

  // "inProgress": one bucket, part-way filled by today's money.
  const bucket = labelFor(state.bucketCode);
  const caption = [
    t("glanceInProgressPut", { amount: formatCents(state.amountCents), bucket }),
    t("glanceInProgressPct", { bucket, pct: Math.round(state.pctCoveredAfterToday) }),
  ].join(" ");
  return { caption, icon: { code: state.bucketCode as ExpenseIconCode, pctCovered: state.pctCoveredAfterToday } };
}
