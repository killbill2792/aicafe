import type { getTranslations } from "next-intl/server";
import type { AlertRow } from "@/lib/data/getAlerts";

type T = Awaited<ReturnType<typeof getTranslations<"Alerts">>>;

/** Icon token, title, subtitle and tone for one alert — never accusatory wording
 * (docs/02-design-system.md). Centralized so the list and detail screens agree. */
export function describeAlert(alert: AlertRow, t: T, categoryLabel: (code: string) => string) {
  switch (alert.kind) {
    case "missing_bill": {
      const code = String(alert.payload.categoryCode ?? "");
      return {
        icon: code || "other",
        title: t("missingBillTitle", { category: categoryLabel(code) }),
        subtitle: t("missingBillSubtitle"),
        tone: "warn" as const,
        actionHref: "/more/bills",
        actionLabel: t("missingBillAction"),
      };
    }
    case "voids": {
      return {
        icon: "card",
        title: t("voidsTitle"),
        subtitle: t("voidsSubtitle"),
        tone: "warn" as const,
        actionHref: "/staff",
        actionLabel: t("voidsAction"),
      };
    }
    case "meal_break": {
      const name = alert.payload.employeeName ? String(alert.payload.employeeName) : t("someone");
      return {
        icon: "staff",
        title: t("mealBreakTitle", { name }),
        subtitle: t("mealBreakSubtitle"),
        tone: "warn" as const,
        actionHref: "/staff",
        actionLabel: t("mealBreakAction"),
      };
    }
    default:
      return {
        icon: "other",
        title: alert.kind,
        subtitle: "",
        tone: "warn" as const,
        actionHref: "/more/alerts",
        actionLabel: t("missingBillAction"),
      };
  }
}
