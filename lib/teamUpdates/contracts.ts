import { z } from "zod";

export const teamUpdateDomainSchema = z.enum(["menu_pricing", "labor", "supplies", "money"]);
export const teamUpdateStatusSchema = z.enum(["new", "seen", "acted", "dismissed"]);
export const teamUpdateActionKindSchema = z.enum(["open", "dismiss", "copy_text", "checkin", "approve"]);
export type TeamUpdateStatus = z.infer<typeof teamUpdateStatusSchema>;
export type TeamUpdateDomain = z.infer<typeof teamUpdateDomainSchema>;

export type TeamUpdate = {
  id: string;
  business_id: string;
  owner_user_id: string;
  agent_id: "alex" | "olivia" | "maya" | "leo";
  domain: TeamUpdateDomain;
  kind: string;
  severity: "info" | "attention" | "action";
  subject_type: string;
  subject_id: string | null;
  facts: Record<string, unknown>;
  text: string;
  locale: string;
  actions: Array<{ kind: z.infer<typeof teamUpdateActionKindSchema>; [key: string]: unknown }>;
  status: TeamUpdateStatus;
  dedupe_key: string;
  notified_at: string | null;
  created_at: string;
};
