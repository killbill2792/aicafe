import { z } from "zod";

/** Client-safe job model shared by the server, the resume route and the page. */
export const AGENT_JOB_STALE_MS = 180_000; // must match ai_agent_job_start's interval
export type AgentJobStatus = "running" | "done" | "failed";
export type AgentJobStep = { tool: string; agent: "alex" | "olivia" | "maya" | "leo" };
export const isJobStepAgent = (value: unknown): value is AgentJobStep["agent"] =>
  value === "alex" || value === "olivia" || value === "maya" || value === "leo";
export type AgentJob = {
  id: string; threadId: string; ownerMessageId: string; status: AgentJobStatus; attempt: number;
  errorCode: string | null; replyMessageId: string | null; progress: AgentJobStep[];
  inbox: string[]; consumed: string[]; heartbeatAt: string; createdAt: string;
};
export type AgentJobStartMode = "started" | "running" | "done" | "absorbed" | "attached" | "busy" | "failed";

const stepSchema = z.object({ tool: z.string().max(60), agent: z.enum(["alex", "olivia", "maya", "leo"]) });
const rowSchema = z.object({
  id: z.uuid(), thread_id: z.uuid(), owner_message_id: z.uuid(),
  status: z.enum(["running", "done", "failed"]), attempt: z.number().int(),
  error_code: z.string().nullable(), reply_message_id: z.uuid().nullable(),
  progress: z.array(z.unknown()), inbox: z.array(z.uuid()).nullable().optional(),
  consumed: z.array(z.uuid()).nullable().optional(),
  heartbeat_at: z.string(), created_at: z.string(),
});

/** Parses a DB row (RPC to_jsonb or PostgREST). Unknown progress entries are dropped. */
export function toAgentJob(row: unknown): AgentJob {
  const r = rowSchema.parse(row);
  return { id: r.id, threadId: r.thread_id, ownerMessageId: r.owner_message_id, status: r.status,
    attempt: r.attempt, errorCode: r.error_code, replyMessageId: r.reply_message_id,
    progress: r.progress.flatMap(step => { const p = stepSchema.safeParse(step); return p.success ? [p.data] : []; }),
    inbox: r.inbox ?? [], consumed: r.consumed ?? [], heartbeatAt: r.heartbeat_at, createdAt: r.created_at };
}

/** A running job with no heartbeat for AGENT_JOB_STALE_MS is shown as failed
 * (the server died) so the page never spins forever. */
export function effectiveAgentJob(job: AgentJob, nowMs = Date.now()): AgentJob {
  if (job.status === "running" && nowMs - Date.parse(job.heartbeatAt) > AGENT_JOB_STALE_MS)
    return { ...job, status: "failed", errorCode: job.errorCode ?? "timeout" };
  return job;
}
