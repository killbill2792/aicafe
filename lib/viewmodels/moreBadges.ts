import { OPEN_HOURS_DAY_KEYS, type OpenHours } from "@/lib/business/openHours";
import type { RecurringCostRow } from "@/lib/data/getRecurringCosts";
import type { UploadHistoryRow } from "@/lib/data/getUploadHistory";
import { totalMonthlyRecurringCostsCents } from "@/lib/expenses/recurringMonthlyTotal";

export type MoreBadgeInputs = {
  openHours?: OpenHours | null;
  toast?: { state: string | null; hasError: boolean; verifiedLocation: boolean } | null;
  uploads?: Pick<UploadHistoryRow, "id" | "status">[];
  missingFeeDays?: number | null;
  bills?: RecurringCostRow[];
  alertCount?: number | null;
  currency?: string;
};

export function buildMoreBadges(input: MoreBadgeInputs) {
  const review = input.uploads?.filter((row) => row.status === "needs_review") ?? [];
  return {
    hoursNotSet: input.openHours === undefined ? false :
      input.openHours === null || OPEN_HOURS_DAY_KEYS.some((key) =>
        !Object.prototype.hasOwnProperty.call(input.openHours, key)),
    toast: input.toast === undefined || input.toast === null ? null :
      input.toast.state === "verified" && !input.toast.hasError && input.toast.verifiedLocation
        ? "connected" as const : "needsAttention" as const,
    uploadsNeedingReview: input.uploads === undefined ? null : review.length,
    firstUploadToReview: review[0]?.id ?? null,
    missingFeeDays: input.missingFeeDays ?? null,
    rentMissing: input.bills === undefined ? false :
      !input.bills.some((row) => row.categoryCode === "rent"),
    monthlyBillsCents: input.bills === undefined ? null : totalMonthlyRecurringCostsCents(input.bills),
    alerts: input.alertCount ?? null,
  };
}
