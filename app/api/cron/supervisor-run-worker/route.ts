import { NextResponse } from "next/server";
import { verifyBearer } from "@/lib/security/bearer";
import { configuredBudget, processOldestDurableRun, startDurableOwnerRun } from "@/lib/ai/supervisor/runs/worker.server";
import { ownerModelCallsLimit } from "@/lib/ai/conversations/usage.server";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { dispatchDueObjectivesAcrossCafes } from "@/lib/ai/supervisor/routines/dispatch.server";
import { runNextLunaAssignment } from "@/lib/ai/supervisor/runs/luna-entry.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const respond = (status: number, body: unknown) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

const authorized = (request: Request) => verifyBearer(request, process.env.CRON_SECRET);
const enabled = () => process.env.SUPERVISOR_RUN_WORKER_ENABLED !== "false" &&
  (process.env.NODE_ENV==="production"||process.env.SUPERVISOR_RUN_WORKER_ENABLED==="true");

/** Resume the existing durable queue. Cron authorization is unchanged. */
export async function GET(request: Request) {
  if (!authorized(request)) return respond(401, { error: "unauthorized" });
  if (!enabled()) return respond(503, { disabled: true });
  const now = new Date();
  const [legacy, replacement, scheduled] = await Promise.allSettled([
    processOldestDurableRun(),
    (async () => runNextLunaAssignment({
      budget: configuredBudget(true), ownerDailyCap: ownerModelCallsLimit(), signal: AbortSignal.timeout(55_000),
    }))(),
    (async () => {
      if (process.env.SUPERVISOR_U4_ENABLED !== "true") return null;
      return dispatchDueObjectivesAcrossCafes(createAdminSupabaseClient(), now, undefined, now.getTime() + 35_000, "replacement");
    })(),
  ]);
  if (legacy.status === "rejected" || replacement.status === "rejected" || scheduled.status === "rejected")
    return respond(503, { error: "supervisor_worker_unavailable" });
  return respond(200, { ...legacy.value, ...(replacement.value.processed ? { replacement: replacement.value } : {}),
    ...(scheduled.value?.admitted || scheduled.value?.failed ? { scheduled: scheduled.value } : {}) });
}

/** Trusted server enqueue of an already persisted owner turn. The worker
 * derives café, owner, thread and the fixed plan from stored authenticated
 * data, never from user/model-supplied identities or step definitions. */
export async function POST(request: Request) {
  if (!authorized(request)) return respond(401, { error: "unauthorized" });
  if (!enabled()) return respond(503, { disabled: true });
  let ownerMessageId: string;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Object.keys(body).length !== 1 || typeof body.ownerMessageId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.ownerMessageId))
      return respond(400, { error: "invalid_owner_message" });
    ownerMessageId = body.ownerMessageId;
  } catch { return respond(400, { error: "invalid_owner_message" }); }
  try {
    const run = await startDurableOwnerRun(ownerMessageId);
    return respond(202, { runId: run.id, status: run.status });
  } catch { return respond(503, { error: "supervisor_run_unavailable" }); }
}
