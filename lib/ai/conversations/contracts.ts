import { z } from "zod";
import { investigationMemorySchema, type InvestigationMemory } from "./investigationMemory";
import {ownerQuestionSchema,pendingOwnerInputSchema,ownerInputResponseSchema,type PendingOwnerInput,type OwnerQuestion} from "@/lib/ai/supervisor/ownerInput/contracts";

/** The owner supplies content and retry keys, NEVER role, identity, tool names or evidence. */
export const createThreadInput = z.strictObject({
  requestId: z.uuid(),
  title: z.string().trim().min(1).max(120).optional(),
});
export const addOwnerMessageInput = z.strictObject({
  clientMessageId: z.uuid(),
  text: z.string().trim().min(1).max(4000),
  locale: z.enum(["en", "es", "ar"]).default("en"),
  ownerInputResponse:ownerInputResponseSchema.optional(),
});
export const threadIdInput = z.uuid();

export const pageInput = z.strictObject({
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});
export const PAGE_SIZE = 50;
export const THREAD_PAGE_SIZE = 20;

export type ConversationScope = {
  businessId: string;
  ownerUserId: string;
};

export type ConversationThread = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
};

export type ConversationMessage = {
  id: string;
  threadId: string;
  role: "owner" | "supervisor";
  contentType: "text" | "blocks";
  text: string | null;
  blocks: unknown[] | null;
  grounding: Record<string, unknown> | null;
  createdAt: string;
  clientMessageId: string | null;
};

export type ConversationPage<T> = { items: T[]; nextOffset: number | null };

/** Future Phase 4 contract: only vetted evidence may enter a Supervisor response. */
export type SupervisorIntent =
  | "cafe_overview" | "profitability" | "menu_pricing" | "staff"
  | "operating_tasks" | "expenses" | "sales_quantity" | "menu_catalog" | "owner_rules" | "unknown";

export type GroundingStatus = "verified" | "estimated" | "partial" | "unavailable" | "insufficient_evidence" | "requires_owner_input";

export type EvidenceReference = {
  source: "cafe_state" | "historical_rollups" | "staff_timecards" | "pricing_engine" | "operating_tasks" | "owner_rules" | "verified_external" | "unverified_external";
  identifier: string;
  asOf: string;
};

export type SupervisorReplyBlock =
  | OwnerQuestion
  | { type: "text"; text: string }
  | { type: "warning"; code: string; text: string }
  | { type: "metric"; label: string; valueCents: number; source: EvidenceReference }
  | { type: "count"; label: string; value: number; source: EvidenceReference }
  | { type: "percent"; label: string; valueBps: number; source: EvidenceReference }
  | { type: "task_status"; taskId: string; status: string; source: EvidenceReference }
  | { type: "task_card"; taskId: string; agent: "alex" | "olivia" | "maya" | "leo";
      title: string; status: "needs_owner" | "needs_response" | "watching" | "handled" | "expired";
      href: string; source: EvidenceReference };

export type GroundedSupervisorReply = {
  investigationMemory?: InvestigationMemory;
  ownerInput?:PendingOwnerInput;
  intent: SupervisorIntent;
  status: GroundingStatus;
  evidence: EvidenceReference[];
  blocks: SupervisorReplyBlock[];
};

/** Only server-verified, allow-listed blocks may be persisted as Supervisor replies. */
export const evidenceReferenceSchema = z.strictObject({
  source: z.enum(["cafe_state", "historical_rollups", "staff_timecards", "pricing_engine", "operating_tasks", "owner_rules", "verified_external", "unverified_external"]),
  identifier: z.string().min(1).max(160),
  asOf: z.string().min(1).max(40),
});
const textBlockSchema = z.strictObject({
  type: z.literal("text"), text: z.string().trim().min(1).max(1200),
});
const warningBlockSchema = z.strictObject({
  type: z.literal("warning"), code: z.string().min(1).max(80),
  text: z.string().trim().min(1).max(1200),
});
const metricBlockSchema = z.strictObject({
  type: z.literal("metric"), label: z.string().min(1).max(140),
  valueCents: z.number().int().safe(),
  source: evidenceReferenceSchema,
});
const countBlockSchema = z.strictObject({
  type: z.literal("count"), label: z.string().min(1).max(140),
  value: z.number().int().nonnegative().safe(), source: evidenceReferenceSchema,
});
const percentBlockSchema = z.strictObject({
  type: z.literal("percent"), label: z.string().min(1).max(140),
  // Basis points: 10000 = 100%. Negative values are a real contraction/loss,
  // not a client-side formatting error.
  valueBps: z.number().int().safe(), source: evidenceReferenceSchema,
});
const taskCardBlockSchema = z.strictObject({
  type: z.literal("task_card"),
  taskId: z.string().min(1).max(200),
  agent: z.enum(["alex", "olivia", "maya", "leo"]),
  title: z.string().min(1).max(160),
  status: z.enum(["needs_owner", "needs_response", "watching", "handled", "expired"]),
  href: z.string().max(800).refine((s) => s.startsWith("/operations?") && !s.startsWith("//")),
  source: evidenceReferenceSchema,
});
const taskBlockSchema = z.strictObject({
  type: z.literal("task_status"), taskId: z.string().min(1).max(200),
  status: z.enum(["needs_owner", "needs_response", "watching", "handled", "expired"]),
  source: evidenceReferenceSchema,
});
export const groundedReplySchema = z.strictObject({
  investigationMemory: investigationMemorySchema.optional(),
  ownerInput:pendingOwnerInputSchema.optional(),
  intent: z.enum(["cafe_overview", "profitability", "menu_pricing", "staff",
    "operating_tasks", "expenses", "sales_quantity", "menu_catalog", "owner_rules", "unknown"]),
  status: z.enum(["verified", "estimated", "partial", "unavailable", "insufficient_evidence","requires_owner_input"]),
  evidence: z.array(evidenceReferenceSchema).max(30),
  blocks: z.array(z.discriminatedUnion("type",
    [textBlockSchema, warningBlockSchema, metricBlockSchema, countBlockSchema, percentBlockSchema,
      taskBlockSchema, taskCardBlockSchema,ownerQuestionSchema])).min(1).max(30),
});
