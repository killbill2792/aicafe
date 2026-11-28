import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it, vi } from "vitest";
import { runClaimedAssignmentProvider } from "./assignment-provider.server";

const database = process.env.SUPERVISOR_RUN_DB_URL;

it.runIf(!!database)("shares the fenced Responses checkpoint across direct and due assignment claims", async () => {
  const url = new URL(database!);
  if (url.protocol !== "postgresql:" || !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !["54322", "55322"].includes(url.port) || url.pathname !== "/postgres") throw new Error("disposable Supabase required");
  const admin = new Client({ connectionString: database });
  const workers = [new Client({ connectionString: database }), new Client({ connectionString: database })];
  const cleanup: { businessId: string; ownerUserId: string }[] = [];
  await admin.connect();
  try {
    for (const worker of workers) {
      await worker.connect();
      await worker.query("set role service_role; set request.jwt.claim.role = 'service_role'");
    }
    const [firstWorker, secondWorker] = workers;
    const rpc = (db: Client, before?: (name: string, args: Record<string, unknown>) => void) =>
      async (name: string, args: Record<string, unknown>) => {
        before?.(name, args);
        const params = Object.entries(args).map(([key], index) => {
          if (!/^p_[a-z_]+$/.test(key)) throw new Error("unexpected test RPC argument");
          return `${key} => $${index + 1}`;
        }).join(", ");
        if (!/^[a-z_0-9]+$/.test(name)) throw new Error("unexpected test RPC name");
        const values = Object.values(args);
        if (name === "luna_provider_inputs") return (await db.query(`select * from public.${name}(${params})`, values)).rows;
        return (await db.query(`select public.${name}(${params}) as result`, values)).rows[0]?.result;
      };

    async function admit(replacement: boolean, question: string) {
      const [businessId, ownerUserId, threadId, messageId] = Array.from({ length: 4 }, () => randomUUID());
      cleanup.push({ businessId, ownerUserId });
      await admin.query("insert into auth.users(id,aud,role,email) values ($1,'authenticated','authenticated',$2)",
        [ownerUserId, `${ownerUserId}@example.invalid`]);
      await admin.query("insert into public.businesses(id,name,timezone) values ($1,'Disposable provider café',current_setting('TimeZone'))", [businessId]);
      await admin.query("insert into public.memberships(business_id,user_id,role) values ($1,$2,'owner')", [businessId, ownerUserId]);
      await admin.query("insert into public.ai_threads(id,business_id,owner_user_id,client_request_id) values ($1,$2,$3,$4)",
        [threadId, businessId, ownerUserId, randomUUID()]);
      await admin.query(`insert into public.ai_messages(id,business_id,owner_user_id,thread_id,author_user_id,role,content_type,text_content,client_message_id)
        values ($1,$2,$3,$4,$3,'owner','text',$5,$6)`, [messageId, businessId, ownerUserId, threadId, question, randomUUID()]);
      if (replacement) await firstWorker.query("insert into public.luna_rollouts(business_id,enabled) values ($1,true)", [businessId]);
      const scope = [businessId, ownerUserId, threadId];
      const { id: runId, engine } = (await firstWorker.query(`select public.supervisor_admit_owner_run_v2($1,$2,$3,$4,$5,'en','{}') as run`,
        [...scope, messageId, "a".repeat(64)])).rows[0].run;
      expect(engine).toBe(replacement ? "replacement" : "legacy");
      return { businessId, ownerUserId, threadId, runId: String(runId), scope, question };
    }

    const claim = async (db: Client, run: Awaited<ReturnType<typeof admit>>) =>
      (await db.query("select public.luna_assignment_claim($1,$2,$3,$4,$5,60) as claim",
        [...run.scope, run.runId, randomUUID()])).rows[0].claim.step;
    const authorize = async (run: Awaited<ReturnType<typeof admit>>, step: { claim_token: string }) =>
      firstWorker.query("select public.supervisor_run_complete_step($1,$2,$3,$4,'authorize_owner',$5,$6)",
        [...run.scope, run.runId, step.claim_token, `owner:${run.ownerUserId}`]);

    const response = { id: "resp_disposable", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Read the last two shifts." }] }] };
    const transport = vi.fn<typeof fetch>(async () => new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`));
    const reserve = vi.fn(async () => ({ launched: () => undefined, complete: async () => undefined }));
    const buildRequest: Parameters<typeof runClaimedAssignmentProvider>[0]["buildRequest"] = async (context, steering) => {
      const message = await firstWorker.query(`select text_content from public.ai_messages where id=$1
        and business_id=$2 and owner_user_id=$3 and thread_id=$4 and role='owner'`,
        [context.ownerMessageId, context.businessId, context.ownerUserId, context.threadId]);
      expect(message.rowCount).toBe(1);
      return { model: "deterministic", instructions: "Answer the scoped owner request.",
        input: [message.rows[0].text_content, ...steering.map(item => item.content)].map(content => ({ role: "user", content })) };
    };
    const signal = new AbortController().signal;
    const owner = await admit(true, "What changed during the afternoon?");
    await authorize(owner, await claim(firstWorker, owner));
    await firstWorker.query("select public.luna_steer_assignment($1,$2,$3,$4,$5,'Include Wednesday.')",
      [...owner.scope, owner.runId, randomUUID()]);
    const firstLease = { ...owner, claimToken: String((await claim(firstWorker, owner)).claim_token) };
    const firstRun = { lease: firstLease, signal, request: transport, reserve, buildRequest };
    await expect(runClaimedAssignmentProvider({ ...firstRun, rpc: rpc(firstWorker, (name, args) => {
      if (name === "supervisor_checkpoint_owner_run_v2" && args.p_action === "complete") throw new Error("simulated loss after save");
    }) })).rejects.toThrow("simulated loss after save");
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).input).toEqual([
      { role: "user", content: owner.question }, { role: "user", content: "Include Wednesday." },
    ]);
    await admin.query("update public.supervisor_run_steps set lease_until=clock_timestamp() where run_id=$1 and step_key='owner_turn'", [owner.runId]);
    await expect(runClaimedAssignmentProvider({ ...firstRun, rpc: rpc(firstWorker) })).rejects.toThrow("durable_job_lease_lost");
    const recoveredLease = { ...owner, claimToken: String((await claim(secondWorker, owner)).claim_token) };
    const recovery = { ...firstRun, lease: recoveredLease, rpc: rpc(secondWorker) };
    const recovered = await runClaimedAssignmentProvider(recovery);
    expect(recovered?.result.response).toEqual(response);
    expect(await runClaimedAssignmentProvider(recovery)).toEqual(recovered);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    if (!recovered) throw new Error("missing recovered owner response");
    const { checkpoint_seq: sequence } = (await admin.query("select checkpoint_seq from public.supervisor_run_steps where run_id=$1 and step_key='owner_turn'", [owner.runId])).rows[0];
    const replyId = randomUUID();
    const authoredText = (recovered.result.response.output[0].content as { text: string }[])[0].text;
    const blocks = [{ type: "text", text: authoredText }];
    const ownerMessageId = (await admin.query("select request_key from public.supervisor_runs where id=$1", [owner.runId])).rows[0].request_key;
    const published = await secondWorker.query(`select public.luna_commit_assignment_result($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as receipt`,
      [...owner.scope, owner.runId, recoveredLease.claimToken, recovered.jobId, sequence,
        recovered.result.operation, replyId, JSON.stringify(blocks),
        { status: "answered", ownerMessageId, durableRunId: owner.runId, agentMetadata: { endReason: "complete" } }]);
    expect(published.rows[0].receipt).toBe(replyId);
    const receipt = await admin.query(`select r.status, m.structured_content from public.supervisor_runs r
      join public.ai_messages m on m.id::text=r.final_report_ref where r.id=$1`, [owner.runId]);
    expect(receipt.rows).toEqual([{ status: "completed", structured_content: blocks }]);

    const legacy = await admit(false, "A legacy owner request.");
    await expect(runClaimedAssignmentProvider({ ...recovery, lease: { ...legacy, claimToken: recoveredLease.claimToken } }))
      .rejects.toThrow("luna_assignment_provider_denied");
    await expect(runClaimedAssignmentProvider({ ...recovery, lease: { ...recoveredLease, businessId: legacy.businessId } }))
      .rejects.toThrow("luna_assignment_provider_denied");

    const due = await admit(true, "Review today’s scheduled stock check.");
    const next = async () => (await secondWorker.query("select public.luna_claim_next_assignment($1,60) as work",
      [randomUUID()])).rows[0].work;
    const authorization = await next();
    expect(authorization.run_id).toBe(due.runId);
    await authorize(due, authorization.claim.step);
    const claimed = await next();
    expect(claimed.run_id).toBe(due.runId);
    expect(claimed.claim.step.step_key).toBe("owner_turn");
    const dueResult = await runClaimedAssignmentProvider({ ...recovery, lease: { ...due, claimToken: claimed.claim.step.claim_token } });
    expect(dueResult?.result.response).toEqual(response);
    expect(transport).toHaveBeenCalledTimes(2);
    const saved = await admin.query(`select checkpoint_receipts->-1->>'receipt' as provider_ref, c.state
      from public.supervisor_run_steps s join public.supervisor_research_continuations c using (run_id)
      where run_id=$1 and s.step_key='owner_turn'`, [due.runId]);
    expect(saved.rows[0]).toEqual({ provider_ref: `provider:${dueResult?.result.operation}`, state: dueResult?.result });
  } finally {
    for (const { businessId, ownerUserId } of cleanup) {
      await admin.query("delete from public.businesses where id=$1", [businessId]);
      await admin.query("delete from auth.users where id=$1", [ownerUserId]);
    }
    await Promise.all([admin, ...workers].map(db => db.end()));
  }
});
