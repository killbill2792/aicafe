import { z } from "zod";

/** The owner supplies content and retry keys, NEVER role, identity, tool names or evidence. */
export const createThreadInput = z.strictObject({
  requestId: z.uuid(),
  title: z.string().trim().min(1).max(120).optional(),
});
export const addOwnerMessageInput = z.strictObject({
  clientMessageId: z.uuid(),
  text: z.string().trim().min(1).max(4000),
});
export const threadIdInput = z.uuid();

export const messagePageInput = z.strictObject({
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
  title: string;
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
  | "operating_tasks" | "expenses" | "unknown";

export type GroundingStatus = "verified" | "estimated" | "insufficient_evidence";

export type EvidenceReference = {
  source: "cafe_state" | "pricing_engine" | "operating_tasks" | "verified_external";
  identifier: string;
  asOf: string;
};

export type SupervisorReplyBlock =
  | { type: "text"; text: string }
  | { type: "warning"; code: string; text: string }
  | { type: "metric"; label: string; valueCents: number; source: EvidenceReference }
  | { type: "task_status"; taskId: string; status: string; source: EvidenceReference };

export type GroundedSupervisorReply = {
  intent: SupervisorIntent;
  status: GroundingStatus;
  evidence: EvidenceReference[];
  blocks: SupervisorReplyBlock[];
};
