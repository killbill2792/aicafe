import type { getTranslations } from "next-intl/server";
import type { AlertRow } from "@/lib/data/getAlerts";
import { RUNNING_COST_CODES } from "@/lib/constants";
import {staffScheduleHref} from "@/lib/scheduling/staffScheduleLinks";

type T = Awaited<ReturnType<typeof getTranslations<"Alerts">>>;

export type AlertDescription = {
  icon: string;
  title: string;
  subtitle: string;
  tone: "warn";
  actionHref: string;
  actionLabel: string;
};

/** List and detail share one safe, localized description, including unknown alert kinds. */
export function describeAlert(alert: AlertRow, t: T, categoryLabel: (code: string) => string): AlertDescription {
  switch (alert.kind) {
    case "missing_bill": {
      const code = String(alert.payload.categoryCode ?? "");
      // Never put an unrecognized category code into an icon, translation or target URL.
      const knownCode = RUNNING_COST_CODES.find((value) => value === code);
      if (!knownCode) break;
      return {
        icon: knownCode,
        title: t("missingBillTitle", { category: categoryLabel(knownCode) }),
        subtitle: t("missingBillSubtitle"),
        tone: "warn",
        actionHref: `/more/bills?category=${encodeURIComponent(knownCode)}`,
        actionLabel: t("missingBillAction"),
      };
    }
    case "voids":
      return {
        icon: "card",
        title: t("voidsTitle"),
        subtitle: t("voidsSubtitle"),
        tone: "warn",
        actionHref: `/more/alerts/${encodeURIComponent(alert.id)}#voids-review`,
        actionLabel: t("voidsAction"),
      };
    case "meal_break": {
      const name = alert.payload.employeeName ? String(alert.payload.employeeName) : t("someone");
      return {
        icon: "staff",
        title: t("mealBreakTitle", { name }),
        subtitle: t("mealBreakSubtitle"),
        tone: "warn",
        actionHref: staffScheduleHref({date:typeof alert.payload.date==="string"?alert.payload.date:undefined,employee:typeof alert.payload.employeeId==="string"?alert.payload.employeeId:undefined}),
        actionLabel: t("mealBreakAction", { name }),
      };
    }
    case "unmatched_sales_items": {
      const names = Array.isArray(alert.payload.itemNames) ? alert.payload.itemNames.filter((name): name is string => typeof name === "string") : [];
      return {
        icon: "other",
        title: t("unmatchedItemsTitle"),
        subtitle: names.length ? t("unmatchedItemsSubtitle", { names: names.join(", ") }) : t("unmatchedItemsSubtitleEmpty"),
        tone: "warn",
        actionHref: "/menu/import-review",
        actionLabel: t("unmatchedItemsAction"),
      };
    }
  }
  return {
    icon: "other",
    title: t("unknownTitle"),
    subtitle: t("unknownSubtitle"),
    tone: "warn",
    actionHref: `/more/alerts/${encodeURIComponent(alert.id)}`,
    actionLabel: t("unknownAction"),
  };
}
