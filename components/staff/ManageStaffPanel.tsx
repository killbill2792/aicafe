"use client";

import { useEffect, useState, useTransition } from "react";
import { CalendarDays, ChevronDown, ChevronUp, Pencil, UserPlus } from "lucide-react";
import { addEmployee, getShiftForDay, markDayAbsent, saveShiftForDay, setEmployeeActive, setWeeklySchedule, updateEmployee } from "@/lib/actions/staff";
import { formatCents, weeklyScheduledHours } from "@/lib/calc";
import { useRouter } from "@/i18n/navigation";
import type { EmployeeRow } from "@/lib/data/getEmployees";
import type { StaffScheduleRow } from "@/lib/data/getStaffSchedules";
import { clearNewEmployeeGuidance, schedulesForMonth, summarizeStaffSchedule } from "@/lib/viewmodels/staffManagement";

type WagePeriod = "hour" | "month" | "year";

function wagePeriodLabel(period: WagePeriod, labels: Labels): string {
  return period === "hour" ? labels.wagePeriodHour : period === "month" ? labels.wagePeriodMonth : labels.wagePeriodYear;
}

function WagePeriodPicker({ value, onChange, labels }: { value: WagePeriod; onChange: (p: WagePeriod) => void; labels: Labels }) {
  const options: WagePeriod[] = ["hour", "month", "year"];
  return (
    <div className="flex gap-2">
      {options.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onChange(p)}
          aria-pressed={value === p}
          className={`min-h-12 flex-1 rounded-xl border-2 text-sm font-bold ${value === p ? "border-ink bg-ink text-paper shadow-sm" : "border-transparent bg-paper text-ink-muted"}`}
        >
          {wagePeriodLabel(p, labels)}
        </button>
      ))}
    </div>
  );
}

type Labels = {
  addStaff: string;
  nameLabel: string;
  roleLabel: string;
  wageLabel: string;
  wagePeriodHour: string;
  wagePeriodMonth: string;
  wagePeriodYear: string;
  salaryScheduleHint: string;
  basedOnScheduleLabel: string;
  add: string;
  noStaff: string;
  editDetails: string;
  saveDetails: string;
  detailsSaved: string;
  cancel: string;
  weeklySchedule: string;
  editSchedule: string;
  weeklyScheduleHint: string;
  dayMon: string;
  dayTue: string;
  dayWed: string;
  dayThu: string;
  dayFri: string;
  daySat: string;
  daySun: string;
  breakLabel: string;
  repeatsWeekly: string;
  repeatsWeeklyHelp: string;
  justForMonth: string;
  justForMonthHelp: string;
  monthLabel: string;
  saveSchedule: string;
  scheduleSaved: string;
  noScheduleSet: string;
  editDay: string;
  editDayHint: string;
  date: string;
  clockIn: string;
  clockOut: string;
  unpaidBreakMinutes: string;
  save: string;
  saved: string;
  didntWork: string;
  predictedTag: string;
  deactivate: string;
  reactivate: string;
  inactiveTag: string;
  wageSummary: string;
  daysSummary: string;
  variedTimes: string;
  variedBreaks: string;
  breakSummary: string;
};

const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun, day_of_week 0=Sun..6=Sat (matches JS Date#getDay())

function dayLabel(dayOfWeek: number, labels: Labels): string {
  return [labels.daySun, labels.dayMon, labels.dayTue, labels.dayWed, labels.dayThu, labels.dayFri, labels.daySat][dayOfWeek];
}

function scheduleSummary(schedules: StaffScheduleRow[], labels: Labels): string {
  const summary = summarizeStaffSchedule(schedules);
  if (!summary) return labels.noScheduleSet;
  const days = summary.dayNumbers.map((day) => dayLabel(day, labels)).join(", ");
  const time = summary.timesVary ? labels.variedTimes : summary.timeRange!;
  const breakText = summary.breaksVary ? labels.variedBreaks : labels.breakSummary.replace("{minutes}", String(summary.breakMinutes));
  return `${labels.daysSummary.replace("{days}", days)} · ${time} · ${breakText}`;
}

export default function ManageStaffPanel({
  employees,
  schedules,
  todayDateStr,
  labels,
  focusEmployeeId,
  focusDate,
}: {
  employees: EmployeeRow[];
  schedules: StaffScheduleRow[];
  todayDateStr: string;
  labels: Labels;
  focusEmployeeId: string | null;
  focusDate: string | null;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [wage, setWage] = useState("");
  const [wagePeriod, setWagePeriod] = useState<WagePeriod>("hour");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusEmployeeId ? [focusEmployeeId] : []));
  const [newEmployeeId, setNewEmployeeId] = useState<string | null>(null);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const addCanSubmit = name.trim() && wage;

  function handleAdd() {
    const wageAmountCents = Math.round((Number(wage) || 0) * 100);
    if (!name.trim() || wageAmountCents <= 0) return;
    setError(null);
    startTransition(async () => {
      const result = await addEmployee({
        name: name.trim(),
        role: role.trim() || undefined,
        wagePeriod,
        wageAmountCents,
      });
      if (result.ok) {
        setName("");
        setRole("");
        setWage("");
        setWagePeriod("hour");
        setNewEmployeeId(result.id);
        setExpanded((prev) => new Set(prev).add(result.id));
      } else {
        setError(result.error);
      }
    });
  }

  const active = employees.filter((e) => e.active);
  const inactive = employees.filter((e) => !e.active);

  return (
    <div className="flex flex-col gap-3.5">
      <section className="flex flex-col gap-3 rounded-card-lg bg-card p-[18px]">
        <h2 className="flex items-center gap-2 text-[17px] font-bold">
          <UserPlus aria-hidden="true" size={20} />
          {labels.addStaff}
        </h2>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={labels.nameLabel}
          className="h-12 rounded-xl border border-line px-3 text-base"
        />
        <input
          type="text"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder={labels.roleLabel}
          className="h-12 rounded-xl border border-line px-3 text-base"
        />
        <WagePeriodPicker value={wagePeriod} onChange={setWagePeriod} labels={labels} />
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-lg font-bold text-ink-muted">$</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={wage}
            onChange={(e) => setWage(e.target.value)}
            placeholder={labels.wageLabel}
            className="h-12 min-w-0 flex-1 rounded-xl border border-line px-3 text-base"
          />
        </div>
        {wagePeriod !== "hour" && <p className="text-xs text-ink-muted">{labels.salaryScheduleHint}</p>}
        {error && <p className="text-sm text-warn">{error}</p>}
        <button
          type="button"
          onClick={handleAdd}
          disabled={isPending || !addCanSubmit}
          className="h-12 rounded-full bg-ink text-base font-bold text-paper disabled:opacity-40"
        >
          {labels.add}
        </button>
      </section>

      <section className="flex flex-col rounded-card-lg bg-card px-[18px] py-2">
        {active.length === 0 ? (
          <p className="py-4 text-[15px] text-ink-muted">{labels.noStaff}</p>
        ) : (
          active.map((emp) => (
            <EmployeeRowItem
              key={emp.id}
              employee={emp}
              schedules={schedules.filter((s) => s.employeeId === emp.id)}
              todayDateStr={todayDateStr}
              labels={labels}
              expanded={expanded.has(emp.id)}
              openScheduleInitially={newEmployeeId === emp.id}
              focusDate={focusEmployeeId === emp.id ? focusDate : null}
              onScheduleSaved={() => setNewEmployeeId((current) => clearNewEmployeeGuidance(current, emp.id))}
              onToggle={() => toggleExpanded(emp.id)}
            />
          ))
        )}
      </section>

      {inactive.length > 0 && (
        <section className="flex flex-col rounded-card-lg bg-card px-[18px] py-2 opacity-70">
          {inactive.map((emp) => (
            <EmployeeRowItem
              key={emp.id}
              employee={emp}
              schedules={schedules.filter((s) => s.employeeId === emp.id)}
              todayDateStr={todayDateStr}
              labels={labels}
              expanded={expanded.has(emp.id)}
              openScheduleInitially={false}
              focusDate={focusEmployeeId === emp.id ? focusDate : null}
              onScheduleSaved={() => setNewEmployeeId((current) => clearNewEmployeeGuidance(current, emp.id))}
              onToggle={() => toggleExpanded(emp.id)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function EmployeeRowItem({
  employee,
  schedules,
  todayDateStr,
  labels,
  expanded,
  openScheduleInitially,
  onScheduleSaved,
  onToggle,
  focusDate,
}: {
  employee: EmployeeRow;
  schedules: StaffScheduleRow[];
  todayDateStr: string;
  labels: Labels;
  expanded: boolean;
  openScheduleInitially: boolean;
  onScheduleSaved: () => void;
  onToggle: () => void;
  focusDate: string | null;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const month = todayDateStr.slice(0, 7);
  const applicableSchedules = schedulesForMonth(schedules, month);
  const ongoingScheduleHours = weeklyScheduledHours(
    applicableSchedules.map((s) => ({ startTime: s.startTime, endTime: s.endTime, unpaidBreakMinutes: s.unpaidBreakMinutes })),
  );
  const hasSchedule = ongoingScheduleHours > 0;

  const [activeEditor, setActiveEditor] = useState<"details" | "schedule" | "day" | null>(focusDate ? "day" : openScheduleInitially ? "schedule" : null);
  const [editName, setEditName] = useState(employee.name);
  const [editRole, setEditRole] = useState(employee.role ?? "");
  const [editWagePeriod, setEditWagePeriod] = useState<WagePeriod>(employee.wagePeriod);
  const [editWage, setEditWage] = useState(
    employee.wageAmountCents ? (employee.wageAmountCents / 100).toFixed(2) : employee.defaultHourlyWageCents ? (employee.defaultHourlyWageCents / 100).toFixed(2) : "",
  );
  const [editStatus, setEditStatus] = useState<"idle" | "saved" | "error">("idle");
  const [editError, setEditError] = useState<string | null>(null);

  function handleSaveDetails() {
    const wageAmountCents = Math.round((Number(editWage) || 0) * 100);
    if (!editName.trim() || wageAmountCents <= 0) return;
    setEditStatus("idle");
    setEditError(null);
    startTransition(async () => {
      const result = await updateEmployee({
        employeeId: employee.id,
        name: editName.trim(),
        role: editRole.trim() || undefined,
        wagePeriod: editWagePeriod,
        wageAmountCents,
      });
      if (result.ok) {
        setEditStatus("saved");
        setActiveEditor(null);
        router.refresh();
        onToggle();
      } else {
        setEditStatus("error");
        setEditError(result.error);
      }
    });
  }

  function handleToggleActive() {
    startTransition(async () => {
      const result = await setEmployeeActive(employee.id, !employee.active);
      if (result.ok) {
        router.refresh();
        if (expanded) onToggle();
      }
    });
  }

  return (
    <div id={`employee-${employee.id}`} className={`scroll-mt-4 border-b border-line py-3 last:border-b-0 ${focusDate ? "rounded-xl ring-2 ring-warn ring-offset-2" : ""}`}>
      <button type="button" onClick={onToggle} className="flex min-h-14 w-full items-center gap-3 text-start">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-good-tint text-[17px] font-extrabold text-staff">
          {employee.name.charAt(0)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-bold">
            {employee.name} {employee.role ? `· ${employee.role}` : ""}
          </span>
          {!employee.active && <span className="text-xs font-semibold text-warn">{labels.inactiveTag}</span>}
          <span className="text-sm text-ink-muted">
            {labels.wageSummary.replace("{wage}", formatCents(employee.wageAmountCents ?? employee.defaultHourlyWageCents ?? 0)).replace("{period}", wagePeriodLabel(employee.wagePeriod, labels))}
          </span>
          <span className="text-sm text-ink-muted">
            {scheduleSummary(applicableSchedules, labels)}
          </span>
        </div>
        {expanded ? <ChevronUp aria-hidden="true" size={18} /> : <ChevronDown aria-hidden="true" size={18} />}
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-2.5 rounded-2xl bg-[#FAF6F0] p-3.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => {
                setActiveEditor((current) => current === "details" ? null : "details");
                setEditStatus("idle");
              }}
              aria-pressed={activeEditor === "details"}
              className={`flex min-h-12 items-center justify-center gap-1 rounded-xl border px-2 text-sm font-semibold ${activeEditor === "details" ? "border-ink bg-ink text-paper" : "border-line bg-card text-ink"}`}
            >
              <Pencil aria-hidden="true" size={13} />
              {labels.editDetails}
            </button>
            <button type="button" onClick={() => setActiveEditor((current) => current === "schedule" ? null : "schedule")} aria-pressed={activeEditor === "schedule"} className={`min-h-12 rounded-xl border px-2 text-sm font-semibold ${activeEditor === "schedule" ? "border-ink bg-ink text-paper" : "border-line bg-card text-ink"}`}>
              {labels.editSchedule}
            </button>
            <button type="button" onClick={() => setActiveEditor((current) => current === "day" ? null : "day")} aria-pressed={activeEditor === "day"} className={`min-h-12 rounded-xl border px-2 text-sm font-semibold ${activeEditor === "day" ? "border-ink bg-ink text-paper" : "border-line bg-card text-ink"}`}>
              {labels.editDay}
            </button>
          </div>

          {activeEditor === "details" && (
            <div className="flex flex-col gap-2 rounded-xl bg-white p-3">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={labels.nameLabel}
                className="min-h-12 rounded-lg border border-line px-2.5 text-sm"
              />
              <input
                type="text"
                value={editRole}
                onChange={(e) => setEditRole(e.target.value)}
                placeholder={labels.roleLabel}
                className="min-h-12 rounded-lg border border-line px-2.5 text-sm"
              />
              <WagePeriodPicker value={editWagePeriod} onChange={setEditWagePeriod} labels={labels} />
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 font-bold text-ink-muted">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  value={editWage}
                  onChange={(e) => setEditWage(e.target.value)}
                  placeholder={labels.wageLabel}
                  className="min-h-12 min-w-0 flex-1 rounded-lg border border-line px-2.5 text-sm"
                />
              </div>
              {editWagePeriod !== "hour" &&
                (hasSchedule ? (
                  <p className="text-xs font-semibold text-ink-muted">{labels.basedOnScheduleLabel.replace("{hours}", ongoingScheduleHours.toFixed(1))}</p>
                ) : (
                  <p className="text-xs text-ink-muted">{labels.salaryScheduleHint}</p>
                ))}
              {editError && <p className="text-sm text-warn">{editError}</p>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveDetails}
                  disabled={isPending || !editName.trim() || !editWage}
                  className="min-h-12 flex-1 rounded-full bg-ink text-sm font-bold text-paper disabled:opacity-40"
                >
                  {editStatus === "saved" ? labels.detailsSaved : labels.saveDetails}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveEditor(null);
                    setEditName(employee.name);
                    setEditRole(employee.role ?? "");
                    setEditWagePeriod(employee.wagePeriod);
                    setEditWage(employee.wageAmountCents ? (employee.wageAmountCents / 100).toFixed(2) : employee.defaultHourlyWageCents ? (employee.defaultHourlyWageCents / 100).toFixed(2) : "");
                  }}
                  className="min-h-12 rounded-full border border-line px-3.5 text-sm font-semibold text-ink-muted"
                >
                  {labels.cancel}
                </button>
              </div>
            </div>
          )}

          {activeEditor === "schedule" && <WeeklyScheduleEditor employee={employee} schedules={schedules} todayDateStr={todayDateStr} labels={labels} onSaved={() => { setActiveEditor(null); onScheduleSaved(); router.refresh(); onToggle(); }} />}

          {activeEditor === "day" && <DayEditor employee={employee} todayDateStr={focusDate ?? todayDateStr} labels={labels} />}

          <button type="button" onClick={handleToggleActive} disabled={isPending} className="min-h-12 rounded-full border border-line text-sm font-semibold text-ink-muted">
            {employee.active ? labels.deactivate : labels.reactivate}
          </button>
        </div>
      )}
    </div>
  );
}

function WeeklyScheduleEditor({ employee, schedules, todayDateStr, labels, onSaved }: { employee: EmployeeRow; schedules: StaffScheduleRow[]; todayDateStr: string; labels: Labels; onSaved: () => void }) {
  const currentMonth = todayDateStr.slice(0, 7);
  const currentMonthRows = schedules.filter((s) => s.effectiveTo !== null && s.effectiveFrom.slice(0, 7) <= currentMonth && s.effectiveTo.slice(0, 7) >= currentMonth);
  const ongoing = schedulesForMonth(schedules, currentMonth);
  const existingBreak = ongoing[0]?.unpaidBreakMinutes ?? 0;

  const [days, setDays] = useState<Record<number, { on: boolean; start: string; end: string }>>(() => {
    const base: Record<number, { on: boolean; start: string; end: string }> = {};
    for (let i = 0; i < 7; i++) {
      const match = ongoing.find((s) => s.dayOfWeek === i);
      base[i] = match ? { on: true, start: match.startTime, end: match.endTime } : { on: false, start: "08:00", end: "16:00" };
    }
    return base;
  });
  const [breakMinutes, setBreakMinutes] = useState(String(existingBreak));
  const [scopeType, setScopeType] = useState<"ongoing" | "month">(currentMonthRows.length > 0 ? "month" : "ongoing");
  const [month, setMonth] = useState(currentMonthRows[0]?.effectiveFrom.slice(0, 7) ?? currentMonth);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const anyDayOn = Object.values(days).some((d) => d.on);

  function toggleDay(i: number) {
    setDays((prev) => ({ ...prev, [i]: { ...prev[i], on: !prev[i].on } }));
  }

  function handleSave() {
    const selectedDays = Object.entries(days)
      .filter(([, v]) => v.on)
      .map(([k, v]) => ({ dayOfWeek: Number(k), startTime: v.start, endTime: v.end, unpaidBreakMinutes: Number(breakMinutes) || 0 }));
    setStatus("idle");
    setError(null);
    startTransition(async () => {
      const result = await setWeeklySchedule({
        employeeId: employee.id,
        days: selectedDays,
        scope: scopeType === "ongoing" ? { type: "ongoing" } : { type: "month", month },
      });
      if (result.ok) { setStatus("saved"); onSaved(); }
      else {
        setStatus("error");
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-white p-3">
      <span className="flex items-center gap-1.5 text-sm font-bold">
        <CalendarDays aria-hidden="true" size={16} />
        {labels.weeklySchedule}
      </span>
      <p className="text-xs text-ink-muted">{labels.weeklyScheduleHint}</p>
      {!anyDayOn && ongoing.length === 0 && <p className="text-xs font-semibold text-ink-muted">{labels.noScheduleSet}</p>}

      <div className="flex flex-col gap-1.5">
        {DAY_ORDER.map((dow) => {
          const d = days[dow];
          return (
            <div key={dow} className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => toggleDay(dow)}
                aria-pressed={d.on}
                className={`min-h-12 w-14 shrink-0 rounded-xl border-2 text-sm font-bold ${d.on ? "border-good bg-good text-white shadow-sm" : "border-transparent bg-paper text-ink-muted"}`}
              >
                {dayLabel(dow, labels)}
              </button>
              {d.on && (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <input
                    type="time"
                    value={d.start}
                    onChange={(e) => setDays((prev) => ({ ...prev, [dow]: { ...prev[dow], start: e.target.value } }))}
                    className="min-h-12 w-full min-w-0 flex-1 rounded-lg border border-line px-1.5 text-sm"
                  />
                  <span className="shrink-0 text-ink-muted">–</span>
                  <input
                    type="time"
                    value={d.end}
                    onChange={(e) => setDays((prev) => ({ ...prev, [dow]: { ...prev[dow], end: e.target.value } }))}
                    className="min-h-12 w-full min-w-0 flex-1 rounded-lg border border-line px-1.5 text-sm"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      {anyDayOn && (
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {labels.breakLabel}
          <input
            type="number"
            min="0"
            max="240"
            value={breakMinutes}
            onChange={(e) => setBreakMinutes(e.target.value)}
            className="min-h-12 w-24 rounded-lg border border-line px-2 text-sm"
          />
        </label>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setScopeType("ongoing")}
            aria-pressed={scopeType === "ongoing"}
            className={`min-h-12 rounded-xl border-2 px-2 text-sm font-bold ${scopeType === "ongoing" ? "border-ink bg-ink text-paper" : "border-transparent bg-paper text-ink-muted"}`}
          >
            {labels.repeatsWeekly}
          </button>
          <p className="text-xs leading-snug text-ink-muted">{labels.repeatsWeeklyHelp}</p>
        </div>
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setScopeType("month")}
            aria-pressed={scopeType === "month"}
            className={`min-h-12 rounded-xl border-2 px-2 text-sm font-bold ${scopeType === "month" ? "border-ink bg-ink text-paper" : "border-transparent bg-paper text-ink-muted"}`}
          >
            {labels.justForMonth}
          </button>
          <p className="text-xs leading-snug text-ink-muted">{labels.justForMonthHelp}</p>
        </div>
      </div>
      {scopeType === "month" && (
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
          {labels.monthLabel}
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="min-h-12 w-40 rounded-lg border border-line px-2 text-sm" />
        </label>
      )}

      {error && <p className="text-sm text-warn">{error}</p>}
      <button
        type="button"
        onClick={handleSave}
        disabled={isPending || !(employee.wageAmountCents && employee.wageAmountCents > 0)}
        className="min-h-12 rounded-full bg-ink text-sm font-bold text-paper disabled:opacity-40"
      >
        {status === "saved" ? labels.scheduleSaved : labels.saveSchedule}
      </button>
    </div>
  );
}

function DayEditor({ employee, todayDateStr, labels }: { employee: EmployeeRow; todayDateStr: string; labels: Labels }) {
  const [date, setDate] = useState(todayDateStr);
  const [clockIn, setClockIn] = useState("08:00");
  const [clockOut, setClockOut] = useState("16:00");
  const [breakMinutes, setBreakMinutes] = useState("30");
  const [wage, setWage] = useState(employee.defaultHourlyWageCents ? (employee.defaultHourlyWageCents / 100).toFixed(2) : "");
  const [source, setSource] = useState<"confirmed" | "predicted" | "none">("none");
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getShiftForDay(employee.id, date).then((shift) => {
      if (cancelled || !shift) return;
      setClockIn(shift.clockIn);
      setClockOut(shift.clockOut);
      setBreakMinutes(String(shift.unpaidBreakMinutes));
      if (shift.hourlyWageCents > 0) setWage((shift.hourlyWageCents / 100).toFixed(2));
      setSource(shift.source);
    });
    return () => {
      cancelled = true;
    };
  }, [date, employee.id]);

  function handleSave() {
    const wageCents = Math.round((Number(wage) || 0) * 100);
    if (wageCents <= 0) return;
    setStatus("idle");
    setError(null);
    startTransition(async () => {
      const result = await saveShiftForDay({
        employeeId: employee.id,
        date,
        clockIn,
        clockOut,
        unpaidBreakMinutes: Number(breakMinutes) || 0,
        hourlyWageCents: wageCents,
      });
      if (result.ok) {
        setStatus("saved");
        setSource("confirmed");
      } else {
        setStatus("error");
        setError(result.error);
      }
    });
  }

  function handleMarkAbsent() {
    setStatus("idle");
    setError(null);
    startTransition(async () => {
      const result = await markDayAbsent({ employeeId: employee.id, date });
      if (result.ok) {
        setClockIn("00:00");
        setClockOut("00:00");
        setBreakMinutes("0");
        setSource("confirmed");
        setStatus("saved");
      } else {
        setStatus("error");
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-xl bg-white p-3">
      <span className="text-sm font-bold">{labels.editDay}</span>
      <p className="text-xs text-ink-muted">{labels.editDayHint}</p>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
        {labels.date}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="min-h-12 rounded-lg border border-line px-2.5 text-sm" />
      </label>
      {source === "predicted" && <span className="text-xs font-semibold text-warn">{labels.predictedTag}</span>}
      <div className="flex min-w-0 gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-ink-muted">
          {labels.clockIn}
          <input type="time" value={clockIn} onChange={(e) => setClockIn(e.target.value)} className="min-h-12 w-full min-w-0 rounded-lg border border-line px-2.5 text-sm" />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-semibold text-ink-muted">
          {labels.clockOut}
          <input
            type="time"
            value={clockOut}
            onChange={(e) => setClockOut(e.target.value)}
            className="min-h-12 w-full min-w-0 rounded-lg border border-line px-2.5 text-sm"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
        {labels.unpaidBreakMinutes}
        <input
          type="number"
          min="0"
          max="240"
          value={breakMinutes}
          onChange={(e) => setBreakMinutes(e.target.value)}
          className="min-h-12 rounded-lg border border-line px-2.5 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
        {labels.wageLabel}
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-bold text-ink-muted">$</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={wage}
            onChange={(e) => setWage(e.target.value)}
            className="min-h-12 min-w-0 flex-1 rounded-lg border border-line px-2.5 text-sm"
          />
          <span className="shrink-0 text-ink-muted">/hr</span>
        </div>
      </label>
      {error && <p className="text-sm text-warn">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending || !wage}
          className="min-h-12 flex-1 rounded-full bg-ink text-sm font-bold text-paper disabled:opacity-40"
        >
          {status === "saved" ? labels.saved : labels.save}
        </button>
        <button type="button" onClick={handleMarkAbsent} disabled={isPending} className="min-h-12 rounded-full border border-line px-3.5 text-sm font-semibold text-ink-muted">
          {labels.didntWork}
        </button>
      </div>
    </div>
  );
}
