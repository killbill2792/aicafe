import { reconcileOperatingTasks } from "./reconcileTasks";
import type { OperatingTask } from "./tasks";

/** How long items stay in the open inbox before they move to Handled as expired. */
export const INBOX_LIMITS = {
  /** A past shift (meal break, coverage) older than this can no longer be fixed. */
  shiftReviewDays: 3,
  /** Reports and notes stay in Watching this long after their subject day. */
  informationalDays: 7,
  /** Handled / expired history shown on the inbox. */
  handledDays: 14,
} as const;

export type InboxExpiredReason = "past_day" | "superseded" | "old";
const DAY_MS = 86_400_000;
const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / DAY_MS);
const isOpen = (task: OperatingTask) => task.status === "needs_owner" || task.status === "needs_response" || task.status === "watching";

/** The day an item is about: the shift, the brief's business day, the event day. */
export function taskSubjectDate(task: OperatingTask): string | null {
  const p = task.payload;
  if (task.kind === "commitment" && isDate(task.dueLocalDate)) return task.dueLocalDate;
  if (isDate(p.shiftDate)) return p.shiftDate;
  if (isDate(p.businessDate)) return p.businessDate;
  if (task.entityType === "event_day" && isDate(task.entityId)) return task.entityId;
  return null;
}

/** Final event-day reports and mid-run notes are written into an event_plan task. */
export const isEventReport = (task: OperatingTask) => task.kind === "event_plan" && task.payload.needsApproval !== true;

/** Items with nothing for the owner to decide. They belong in Watching, never Needs you. */
export function isInformational(task: OperatingTask): boolean {
  return task.kind === "daily_brief" || task.payload.midRun === true || isEventReport(task);
}

/** One stable key per real-world item. Two writers or two runs for the same thing collapse here. */
export function inboxKey(task: OperatingTask): string {
  const day = taskSubjectDate(task);
  if (task.kind === "commitment" && task.ownerUserId && task.dedupeKey)
    return "commitment:" + task.ownerUserId + ":" + task.dedupeKey;
  if (task.kind === "daily_brief" && day) return "daily_brief:" + day;
  if (task.kind === "event_plan" && task.entityId) {
    if (task.payload.midRun === true) return "event_note:" + task.entityId + ":" + (day ?? "");
    return (isEventReport(task) ? "event_report:" : "event_plan:") + task.entityId;
  }
  return task.id;
}

const newestFirst = (a: OperatingTask, b: OperatingTask) =>
  (taskSubjectDate(b) ?? "").localeCompare(taskSubjectDate(a) ?? "") || b.createdAt.localeCompare(a.createdAt);
// A read-time expiry is dated by the item's own day, so it leaves Handled on schedule.
const expire = (task: OperatingTask, reason: InboxExpiredReason, now: string): OperatingTask => {
  const day = taskSubjectDate(task);
  return { ...task, status: "expired", resolvedAt: task.resolvedAt ?? (day ? day + "T23:59:59.000Z" : now),
    payload: { ...task.payload, expiredReason: reason } };
};

/**
 * Read-only inbox: what the stored rows plus today's derived items mean right now.
 * It never writes. It replays the same persistence plan the old page-load sync wrote
 * (insert / refresh / expire), collapses repeats of the same item, moves notes and
 * reports to Watching and moves past or superseded items to Handled as expired.
 * `today` is the café-local date.
 */
export function settleInboxTasks(stored: readonly OperatingTask[], derived: readonly OperatingTask[] | null, now: Date, today: string): OperatingTask[] {
  const byId = new Map(stored.map((task) => [task.id, task]));
  // null = today's derived items are not known here (a cron); stored price reviews are kept as stored.
  if (derived) {
    const plan = reconcileOperatingTasks([...stored], [...derived], now);
    for (const task of [...plan.refresh, ...plan.expire, ...plan.insert]) byId.set(task.id, task);
  }
  // Collapse repeats: keep the newest row of each key.
  const byKey = new Map<string, OperatingTask>();
  for (const task of [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const key = inboxKey(task);
    if (!byKey.has(key)) byKey.set(key, task);
  }
  const tasks = [...byKey.values()];
  const at = now.toISOString();
  const newestBrief = tasks.filter((task) => task.kind === "daily_brief").sort(newestFirst)[0];
  const settled = tasks.map((task): OperatingTask => {
    if (!isOpen(task)) return task;
    // A promised follow-up is durable; ordinary read-time expiry cannot close it.
    if (task.kind === "commitment") return task;
    const day = taskSubjectDate(task);
    const age = day ? daysBetween(day, today) : null;
    if (task.kind === "daily_brief" && task !== newestBrief) return expire(task, "superseded", at);
    // An event plan for a day that has passed can no longer be approved.
    if (task.kind === "event_plan" && task.payload.needsApproval === true && age !== null && age > 0) return expire(task, "past_day", at);
    if (task.kind === "staff_coverage" && age !== null && age > INBOX_LIMITS.shiftReviewDays) return expire(task, "past_day", at);
    if (isInformational(task)) {
      if (age !== null && age > INBOX_LIMITS.informationalDays) return expire(task, "old", at);
      return task.status === "watching" ? task : { ...task, status: "watching" };
    }
    return task;
  });
  const cutoff = now.getTime() - INBOX_LIMITS.handledDays * DAY_MS;
  return settled
    .filter((task) => isOpen(task) || Date.parse(task.resolvedAt ?? task.createdAt) >= cutoff)
    .sort(newestFirst);
}

/** A past-shift alert (meal break, early clock-in, overstaffing) that can no longer be acted on. */
export function isStaleShiftAlert(alert: { kind: string; payload: Record<string, unknown> }, today: string): boolean {
  if (!["meal_break", "early_clockin", "overstaffed"].includes(alert.kind)) return false;
  const day = alert.payload.date ?? alert.payload.shiftDate ?? alert.payload.businessDate;
  return isDate(day) && daysBetween(day, today) > INBOX_LIMITS.shiftReviewDays;
}

/** Whole days between an ISO time and the café-local date (0 = today). */
export function ageInDays(iso: string, today: string): number {
  return Math.max(0, daysBetween(iso.slice(0, 10), today));
}

/** "Mon, Nov 2" in the owner's language. The date is a café-local calendar day. */
export function formatInboxDay(day: string, locale: string): string {
  if (!isDate(day)) return day;
  return new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(day + "T12:00:00Z"));
}
