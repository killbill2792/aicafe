import "server-only";
import { z } from "zod";
import { insertTeamUpdate,type MonitorUpdateLease } from "@/lib/data/teamUpdates.server";
import { agentForTask, type OperatingTaskKind } from "@/lib/operating/tasks";
import { teamUpdateActionKindSchema, teamUpdateDomainSchema } from "./contracts";

export const writeTeamUpdateSchema = z.object({
  businessId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  domain: teamUpdateDomainSchema,
  kind: z.string().trim().min(1),
  severity: z.enum(["info", "attention", "action"]),
  subjectType: z.string().trim().min(1),
  subjectId: z.string().uuid().nullable().optional(),
  facts: z.record(z.string(), z.unknown()).default({}),
  text: z.string().trim().min(1).refine(value => Array.from(value).length <= 600, "Text exceeds 600 characters"),
  locale: z.enum(["en", "es", "ar"]),
  actions: z.array(z.object({ kind: teamUpdateActionKindSchema }).passthrough()).default([]),
  dedupeKey: z.string().trim().min(1),
}).strict();
export type WriteTeamUpdateInput = z.input<typeof writeTeamUpdateSchema>;

const domainTaskKind: Record<z.infer<typeof teamUpdateDomainSchema>, OperatingTaskKind> = {
  menu_pricing: "price_review",
  labor: "staff_coverage",
  supplies: "supply_check",
  money: "money_update",
};

/** Validate and map owner-facing messages; persistence lives exclusively in lib/data. */
export async function writeTeamUpdate(input: WriteTeamUpdateInput,
  signal?:AbortSignal,lease?:MonitorUpdateLease): Promise<{ created: boolean }> {
  const value = writeTeamUpdateSchema.parse(input);
  const created = await insertTeamUpdate({
    business_id: value.businessId,
    owner_user_id: value.ownerUserId,
    agent_id: agentForTask(domainTaskKind[value.domain]),
    domain: value.domain,
    kind: value.kind,
    severity: value.severity,
    subject_type: value.subjectType,
    subject_id: value.subjectId ?? null,
    facts: value.facts,
    text: value.text,
    locale: value.locale,
    actions: value.actions,
    dedupe_key: value.dedupeKey,
  },signal,lease);
  return { created };
}
