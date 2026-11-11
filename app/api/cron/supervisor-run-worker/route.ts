import { NextResponse } from "next/server";
import { verifyBearer } from "@/lib/security/bearer";
import { processOldestDurableRun, startDurableOwnerRun } from "@/lib/ai/supervisor/runs/worker.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
const respond = (status: number, body: unknown) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

const authorized = (request: Request) => verifyBearer(request, process.env.CRON_SECRET);
const enabled = () => process.env.SUPERVISOR_RUN_WORKER_ENABLED === "true";

/** Explicitly opt-in only. Not registered with Vercel cron or any new timer. */
export async function GET(request: Request) {
  if (!authorized(request)) return respond(401, { error: "unauthorized" });
  if (!enabled()) return respond(503, { disabled: true });
  try { return respond(200, await processOldestDurableRun()); }
  catch { return respond(503, { error: "supervisor_worker_unavailable" }); }
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
