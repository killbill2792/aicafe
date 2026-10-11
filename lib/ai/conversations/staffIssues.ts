import type { OperatingTask } from "@/lib/operating/tasks";
import type { KnownSlice } from "@/lib/operating/types";
import type { EvidenceReference, GroundedSupervisorReply, SupervisorReplyBlock } from "./contracts";
import { assessGrounding } from "./grounding";

type Locale = "en" | "es" | "ar";
type StaffCopy = {
  summary: (needs: number, watching: number) => string;
  none: string;
  missing: string;
  estimated: string;
  taskName: string;
  taskCard: (name: string) => string;
};

/** Route only unambiguous questions about current staff problems to persisted Team coverage.
 * Historical requests, payroll and broad staff analytics remain in the normal planner.
 * This is deliberately NOT a keyword-to-answer shortcut: the facts always come from
 * the authenticated business's persisted operating_tasks reader.
 */
export function isCurrentStaffIssuesQuestion(text: string, locale: Locale): boolean {
  const normalized = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (locale === "ar") {
    if (/امس|بالامس|الاسبوع الماضي|الشهر الماضي|غدا|رواتب|راتب|اجور/.test(normalized)) return false;
    return /موظف|موظفين|موظفات|العاملين|العمال|الطاقم|تغطية|الورديات/.test(normalized) &&
      /مشاكل|مشكلة|اشكال|نقص|غياب|تاخر|التغطية/.test(normalized);
  }
  if (locale === "es") {
    if (/\b(ayer|semana pasada|mes pasado|manana|nomina|salario|sueldos?|pagos?)\b/.test(normalized)) return false;
    return /\b(personal|emplead[oa]s?|trabajadores?|turnos?|cobertura)\b/.test(normalized) &&
      /\b(problemas?|incidencias?|faltas?|ausencias?|retrasos?|cobertura|escasez)\b/.test(normalized);
  }
  if (/\b(yesterday|last week|last month|tomorrow|next week|payroll|salar(?:y|ies)|wages?|paychecks?|labor costs?)\b/.test(normalized)) return false;
  return /\b(staff|staffing|employees?|workers?|shifts?|coverage)\b/.test(normalized) &&
    /\b(issues?|problems?|concerns?|shortages?|gaps?|absen(?:t|ce)|late|no[ -]?shows?|understaffed|coverage)\b/.test(normalized);
}

/** Ground staff issue cards in the existing read-only Team inbox, never in AI guesses
 * or raw labor signals. A zero means no *recorded open coverage tasks*, not no
 * staffing problems anywhere in the business.
 */
export function answerCurrentStaffIssues(input: {
  tasks: KnownSlice<OperatingTask[]>;
  asOf: string;
  copy: StaffCopy;
}): GroundedSupervisorReply {
  const { tasks, asOf, copy } = input;
  const source: EvidenceReference = { source: "operating_tasks", identifier: "persisted_staff_coverage_tasks", asOf };
  const assessment = assessGrounding("staff", tasks, [source]);
  if (!tasks.available || assessment.status === "insufficient_evidence") {
    return { intent: "staff", status: "insufficient_evidence", evidence: [],
      blocks: [{ type: "warning", code: "staff_records_unavailable", text: copy.missing }] };
  }

  const open = tasks.value.filter((task) => task.kind === "staff_coverage" &&
    (task.status === "needs_owner" || task.status === "needs_response" || task.status === "watching"));
  const needs = open.filter((task) => task.status === "needs_owner" || task.status === "needs_response").length;
  const watching = open.filter((task) => task.status === "watching").length;
  const blocks: SupervisorReplyBlock[] = [{
    type: "text", text: open.length ? copy.summary(needs, watching) : copy.none,
  }];
  const evidence: EvidenceReference[] = [source];

  for (const task of open.slice(0, 6)) {
    const taskRef: EvidenceReference = {
      source: "operating_tasks", identifier: ("task:" + task.id).slice(0, 160), asOf,
    };
    const employee = typeof task.payload.employeeName === "string"
      ? task.payload.employeeName.trim().slice(0, 65) : "";
    const tab = task.status === "watching" ? "watching" : "needs_you";
    evidence.push(taskRef);
    blocks.push({
      type: "task_card", taskId: task.id.slice(0, 200), agent: task.agentId,
      title: (employee ? copy.taskCard(employee) : copy.taskName).slice(0, 160),
      status: task.status, href: "/operations?status=" + tab + "&agent=" + task.agentId,
      source: taskRef,
    });
  }
  if (assessment.status === "estimated") {
    blocks.push({ type: "warning", code: "estimated", text: copy.estimated });
  }
  return { intent: "staff", status: assessment.status, evidence, blocks };
}
