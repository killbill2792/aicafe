import "server-only";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import type { ConversationScope } from "./contracts";
import type { SupervisorDiagnostic } from "./diagnostics.server";

export type SupervisorProgressStage = "reading" | "answering" | "done" | "limited";
export type SupervisorProgressAgent = NonNullable<SupervisorDiagnostic["agent"]>;

/** Best-effort live status for the chat composer ("Alex is checking your
 * pricing…"). Never blocks or fails the owner's turn: a write failure here
 * only means the status bar stays stale, never a lost or corrupted reply. */
export async function recordSupervisorProgress(params: {
  scope: ConversationScope; threadId: string; clientMessageId: string;
  agent: SupervisorProgressAgent; stage: SupervisorProgressStage; step: number; attempt: string;
}): Promise<void> {
  try {
    const admin = createAdminSupabaseClient();
    // These calls are fire-and-forget and race each other in flight; the
    // step-ordered RPC (not a plain upsert) keeps whichever write carries the
    // highest step within the same attempt, so a slower earlier round can
    // never overwrite a later one. `attempt` is a fresh id per POST
    // invocation: a retried turn reuses the same clientMessageId (and row)
    // but must not have its own step count blocked by whatever step the
    // previous, failed attempt happened to leave behind.
    await admin.rpc("record_supervisor_progress", {
      p_thread_id: params.threadId, p_client_message_id: params.clientMessageId,
      p_business_id: params.scope.businessId, p_owner_user_id: params.scope.ownerUserId,
      p_agent: params.agent, p_stage: params.stage, p_step: params.step, p_attempt: params.attempt,
    });
  } catch { /* status is a UI nicety only; never surfaces to the owner turn. */ }
}

/** Translate an internal investigation diagnostic into the bounded
 * agent/stage pair the owner-facing status bar may show. Returns null for
 * every diagnostic that isn't progress-relevant (most of them). */
export function progressFromDiagnostic(event: SupervisorDiagnostic):
  {agent: SupervisorProgressAgent; stage: SupervisorProgressStage} | null {
  if (event.stage === "investigation_round" && event.agent)
    return { agent: event.agent, stage: event.agent === "supervisor" ? "answering" : "reading" };
  if (event.stage === "grounded_answer") return { agent: "supervisor", stage: "done" };
  if (event.stage === "investigation_exhausted") return { agent: "supervisor", stage: "limited" };
  return null;
}
