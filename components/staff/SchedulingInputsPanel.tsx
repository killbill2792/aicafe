"use client";

import { useTranslations } from "next-intl";
import type { EmployeeRow } from "@/lib/data/getEmployees";
import { summarizeStaffWeeklyAvailability } from "@/lib/scheduling/availabilitySummary";
import AvailabilityEditor, { type SchedulingRow, type SchedulingLocation } from "./AvailabilityEditor";
import AvailabilityExceptionsEditor from "./AvailabilityExceptionsEditor";
import SchedulingPreferencesEditor from "./SchedulingPreferencesEditor";
import StaffQualificationsEditor from "./StaffQualificationsEditor";
import WageProvenancePanel from "./WageProvenancePanel";
import StaffCoverageEditor from "./StaffCoverageEditor";

export type SchedulingClientRecords = {
  availability_rule: SchedulingRow[];
  availability_exception: SchedulingRow[];
  preferences: SchedulingRow[];
  preference_window: SchedulingRow[];
  qualification_type: SchedulingRow[];
  qualification: SchedulingRow[];
  coverage: SchedulingRow[];
  compensation: SchedulingRow[];
};
export const emptySchedulingRecords: SchedulingClientRecords = {
  availability_rule:[],availability_exception:[],preferences:[],preference_window:[],
  qualification_type:[],qualification:[],coverage:[],compensation:[],
};

export function StaffAvailabilitySection({ employee, records, locations, today }: {
  employee:EmployeeRow; records:SchedulingClientRecords; locations:SchedulingLocation[]; today:string;
}) {
  const t=useTranslations("SchedulingAvailability");
  const summary = summarizeStaffWeeklyAvailability(
    records.availability_rule, records.preferences, employee.id, today,
  );
  const status = summary.confirmedNoWorkDays === 7
    ? t("confirmedNoWorkWeek")
    : [
        summary.availableWindows > 0
          ? t("windowCount", { count: summary.availableWindows }) : null,
        summary.availableWindows > 0
          ? t("confirmedCount", { count: summary.confirmedWindows }) : null,
        summary.confirmedNoWorkDays > 0
          ? t("noWorkDaysCount", { count: summary.confirmedNoWorkDays }) : null,
        summary.unrecordedDays > 0
          ? (summary.unrecordedDays === 7
              ? t("notRecorded") : t("missingWeekdaysCount", { count: summary.unrecordedDays }))
          : null,
      ].filter(Boolean).join(" · ");
  return <details className="rounded-xl border border-line bg-paper p-3">
    <summary className="min-h-12 cursor-pointer text-[17px] font-bold focus-visible:outline-2 focus-visible:outline-offset-2">
      {t("title")} · {status}
    </summary>
    <p className="py-2 text-[17px] text-ink-muted">{t("doesNotAssign")}</p>
    <div className="flex flex-col gap-3">
      <AvailabilityEditor employeeId={employee.id} rows={records.availability_rule}
        preferences={records.preferences} locations={locations} today={today}/>
      <AvailabilityExceptionsEditor employeeId={employee.id} rows={records.availability_exception}
        locations={locations} today={today}/>
      <SchedulingPreferencesEditor employeeId={employee.id} preferences={records.preferences}
        windows={records.preference_window} today={today}/>
      <StaffQualificationsEditor employeeId={employee.id} types={records.qualification_type}
        assignments={records.qualification} locations={locations} today={today}/>
      <WageProvenancePanel employee={employee} records={records.compensation}/>
    </div>
  </details>;
}

export function StaffCoverageSection({records,locations,businessTimezone,today}:{
  records:SchedulingClientRecords;locations:SchedulingLocation[];
  businessTimezone:string;today:string;
}) {
  return <StaffCoverageEditor rows={records.coverage} locations={locations}
    qualifications={records.qualification_type} businessTimezone={businessTimezone} today={today}/>;
}

export function StaffAvailabilityUnavailable() {
  const t=useTranslations("SchedulingAvailability");
  return <p role="status" className="rounded-xl bg-paper px-4 py-3 text-[17px] text-ink-muted">
    {t("featureUnavailable")}
  </p>;
}
