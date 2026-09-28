import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getEmployees } from "@/lib/data/getEmployees";
import { getSnapshot } from "@/lib/data/getSnapshot";
import BackHeader from "@/components/shared/BackHeader";
import ManageStaffPanel from "@/components/staff/ManageStaffPanel";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function ManageStaffPage() {
  await requireOwnBusiness();
  const t = await getTranslations("ManageStaff");
  const tCommon = await getTranslations("Common");

  const [employees, snapshot] = await Promise.all([getEmployees(), getSnapshot()]);

  return (
    <main className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={tCommon("back")} />
      <ManageStaffPanel
        employees={employees}
        todayDateStr={snapshot.todayDateStr}
        labels={{
          addStaff: t("addStaff"),
          nameLabel: t("nameLabel"),
          roleLabel: t("roleLabel"),
          wageLabel: t("wageLabel"),
          add: t("add"),
          noStaff: t("noStaff"),
          logHours: t("logHours"),
          date: t("date"),
          clockIn: t("clockIn"),
          clockOut: t("clockOut"),
          unpaidBreakMinutes: t("unpaidBreakMinutes"),
          save: t("save"),
          saved: t("saved"),
          deactivate: t("deactivate"),
          reactivate: t("reactivate"),
          inactiveTag: t("inactiveTag"),
        }}
      />
    </main>
  );
}
