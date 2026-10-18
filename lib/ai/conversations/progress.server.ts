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
  agent: SupervisorProgressAgent; stage: SupervisorProgressStage;
}): Promise<void> {
  try {
    const admin = createAdminSupabaseClient();
    await admin.from("ai_supervisor_progress").upsert({
      thread_id: params.threadId, client_message_id: params.clientMessageId,
      business_id: params.scope.businessId, owner_user_id: params.scope.ownerUserId,
      agent: params.agent, stage: params.stage, updated_at: new Date().toISOString(),
    }, { onConflict: "thread_id,client_message_id" });
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
