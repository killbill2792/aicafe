import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getEmployees } from "@/lib/data/getEmployees";
import { getStaffSchedules } from "@/lib/data/getStaffSchedules";
import { getSnapshot } from "@/lib/data/getSnapshot";
import BackHeader from "@/components/shared/BackHeader";
import ManageStaffPanel from "@/components/staff/ManageStaffPanel";
import PageShell from "@/components/shared/PageShell";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function ManageStaffPage({ searchParams }: { searchParams: Promise<{ employee?: string; date?: string }> }) {
  await requireOwnBusiness();
  const t = await getTranslations("ManageStaff");
  const tCommon = await getTranslations("Common");

  const [{ employee, date }, employees, schedules, snapshot] = await Promise.all([searchParams, getEmployees(), getStaffSchedules(), getSnapshot()]);
  const focusEmployeeId = employees.some((candidate) => candidate.id === employee) ? employee ?? null : null;
  const focusDate = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? date! : null;

  return (
    <PageShell className="flex flex-col gap-3.5 px-4 pb-4 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={tCommon("back")} />
      <ManageStaffPanel
        employees={employees}
        schedules={schedules}
        todayDateStr={snapshot.todayDateStr}
        focusEmployeeId={focusEmployeeId}
        focusDate={focusDate}
        labels={{
          addStaff: t("addStaff"),
          nameLabel: t("nameLabel"),
          roleLabel: t("roleLabel"),
          wageLabel: t("wageLabel"),
          wagePeriodHour: t("wagePeriodHour"),
          wagePeriodMonth: t("wagePeriodMonth"),
          wagePeriodYear: t("wagePeriodYear"),
          salaryScheduleHint: t("salaryScheduleHint"),
          basedOnScheduleLabel: t("basedOnScheduleLabel"),
          add: t("add"),
          noStaff: t("noStaff"),
          editDetails: t("editDetails"),
          saveDetails: t("saveDetails"),
          detailsSaved: t("detailsSaved"),
          cancel: t("cancel"),
          weeklySchedule: t("weeklySchedule"),
          editSchedule: t("editSchedule"),
          weeklyScheduleHint: t("weeklyScheduleHint"),
          dayMon: t("dayMon"),
          dayTue: t("dayTue"),
          dayWed: t("dayWed"),
          dayThu: t("dayThu"),
          dayFri: t("dayFri"),
          daySat: t("daySat"),
          daySun: t("daySun"),
          breakLabel: t("breakLabel"),
          repeatsWeekly: t("repeatsWeekly"),
          repeatsWeeklyHelp: t("repeatsWeeklyHelp"),
          justForMonth: t("justForMonth"),
          justForMonthHelp: t("justForMonthHelp"),
          monthLabel: t("monthLabel"),
          saveSchedule: t("saveSchedule"),
          scheduleSaved: t("scheduleSaved"),
          noScheduleSet: t("noScheduleSet"),
          editDay: t("editDay"),
          editDayHint: t("editDayHint"),
          date: t("date"),
          clockIn: t("clockIn"),
          clockOut: t("clockOut"),
          unpaidBreakMinutes: t("unpaidBreakMinutes"),
          save: t("save"),
          saved: t("saved"),
          didntWork: t("didntWork"),
          predictedTag: t("predictedTag"),
          deactivate: t("deactivate"),
          reactivate: t("reactivate"),
          inactiveTag: t("inactiveTag"),
          wageSummary: t("wageSummary"),
          daysSummary: t("daysSummary"),
          variedTimes: t("variedTimes"),
          variedBreaks: t("variedBreaks"),
          breakSummary: t("breakSummary"),
        }}
      />
    </PageShell>
  );
}
