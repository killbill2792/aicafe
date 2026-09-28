"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronUp, Clock, UserPlus } from "lucide-react";
import { addEmployee, logShift, setEmployeeActive } from "@/lib/actions/staff";
import type { EmployeeRow } from "@/lib/data/getEmployees";

type Labels = {
  addStaff: string;
  nameLabel: string;
  roleLabel: string;
  wageLabel: string;
  add: string;
  noStaff: string;
  logHours: string;
  date: string;
  clockIn: string;
  clockOut: string;
  unpaidBreakMinutes: string;
  save: string;
  saved: string;
  deactivate: string;
  reactivate: string;
  inactiveTag: string;
};

export default function ManageStaffPanel({ employees, todayDateStr, labels }: { employees: EmployeeRow[]; todayDateStr: string; labels: Labels }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [wage, setWage] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  function handleAdd() {
    const wageCents = Math.round((Number(wage) || 0) * 100);
    if (!name.trim() || wageCents <= 0) return;
    setError(null);
    startTransition(async () => {
      const result = await addEmployee({ name: name.trim(), role: role.trim() || undefined, defaultHourlyWageCents: wageCents });
      if (result.ok) {
        setName("");
        setRole("");
        setWage("");
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
          <span className="text-sm text-ink-muted">/hr</span>
        </div>
        {error && <p className="text-sm text-warn">{error}</p>}
        <button
          type="button"
          onClick={handleAdd}
          disabled={isPending || !name.trim() || !wage}
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
              todayDateStr={todayDateStr}
              labels={labels}
              expanded={expanded === emp.id}
              onToggle={() => setExpanded(expanded === emp.id ? null : emp.id)}
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
              todayDateStr={todayDateStr}
              labels={labels}
              expanded={false}
              onToggle={() => {}}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function EmployeeRowItem({
  employee,
  todayDateStr,
  labels,
  expanded,
  onToggle,
}: {
  employee: EmployeeRow;
  todayDateStr: string;
  labels: Labels;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [date, setDate] = useState(todayDateStr);
  const [clockIn, setClockIn] = useState("08:00");
  const [clockOut, setClockOut] = useState("16:00");
  const [breakMinutes, setBreakMinutes] = useState("30");
  const [wage, setWage] = useState(employee.defaultHourlyWageCents ? (employee.defaultHourlyWageCents / 100).toFixed(2) : "");
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  function handleLogShift() {
    const wageCents = Math.round((Number(wage) || 0) * 100);
    if (wageCents <= 0) return;
    setStatus("idle");
    setError(null);
    startTransition(async () => {
      const result = await logShift({
        employeeId: employee.id,
        date,
        clockIn,
        clockOut,
        unpaidBreakMinutes: Number(breakMinutes) || 0,
        hourlyWageCents: wageCents,
      });
      if (result.ok) setStatus("saved");
      else {
        setStatus("error");
        setError(result.error);
      }
    });
  }

  function handleToggleActive() {
    startTransition(() => {
      void setEmployeeActive(employee.id, !employee.active);
    });
  }

  return (
    <div className="border-b border-line py-3 last:border-b-0">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-3 text-left">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-good-tint text-[17px] font-extrabold text-staff">
          {employee.name.charAt(0)}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-bold">
            {employee.name} {employee.role ? `· ${employee.role}` : ""}
          </span>
          {!employee.active && <span className="text-xs font-semibold text-warn">{labels.inactiveTag}</span>}
        </div>
        {expanded ? <ChevronUp aria-hidden="true" size={18} /> : <ChevronDown aria-hidden="true" size={18} />}
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-2.5 rounded-2xl bg-[#FAF6F0] p-3.5">
          <span className="flex items-center gap-1.5 text-sm font-bold">
            <Clock aria-hidden="true" size={16} />
            {labels.logHours}
          </span>
          <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted">
            {labels.date}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-11 rounded-lg border border-line px-2.5 text-sm" />
          </label>
          <div className="flex gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs font-semibold text-ink-muted">
              {labels.clockIn}
              <input type="time" value={clockIn} onChange={(e) => setClockIn(e.target.value)} className="h-11 rounded-lg border border-line px-2.5 text-sm" />
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs font-semibold text-ink-muted">
              {labels.clockOut}
              <input
                type="time"
                value={clockOut}
                onChange={(e) => setClockOut(e.target.value)}
                className="h-11 rounded-lg border border-line px-2.5 text-sm"
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
              className="h-11 rounded-lg border border-line px-2.5 text-sm"
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
                className="h-11 min-w-0 flex-1 rounded-lg border border-line px-2.5 text-sm"
              />
              <span className="shrink-0 text-ink-muted">/hr</span>
            </div>
          </label>
          {error && <p className="text-sm text-warn">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleLogShift}
              disabled={isPending || !wage}
              className="h-11 flex-1 rounded-full bg-ink text-sm font-bold text-paper disabled:opacity-40"
            >
              {status === "saved" ? labels.saved : labels.save}
            </button>
            <button type="button" onClick={handleToggleActive} disabled={isPending} className="h-11 rounded-full border border-line px-3.5 text-sm font-semibold text-ink-muted">
              {employee.active ? labels.deactivate : labels.reactivate}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
