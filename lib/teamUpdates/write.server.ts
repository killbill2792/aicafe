import "server-only";
import { z } from "zod";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
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

/** Trusted server writer. Business/dedupe unique index makes retries safe. */
export async function writeTeamUpdate(input: WriteTeamUpdateInput): Promise<{ created: boolean }> {
  const value = writeTeamUpdateSchema.parse(input);
  const db = createAdminSupabaseClient();
  // The service-role client bypasses RLS; validate the owner/business pair.
  const { data: membership, error: membershipError } = await db.from("memberships")
    .select("user_id").eq("business_id", value.businessId)
    .eq("user_id", value.ownerUserId).eq("role", "owner").maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) throw new Error("Team update owner membership required");

  const { data, error } = await db.from("team_updates").upsert({
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
  }, { onConflict: "business_id,dedupe_key", ignoreDuplicates: true })
    .select("id").maybeSingle();
  if (error) throw error;
  return { created: data !== null };
}
