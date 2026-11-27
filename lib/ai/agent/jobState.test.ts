import { describe, expect, it } from "vitest";
import { AGENT_JOB_STALE_MS, effectiveAgentJob, toAgentJob } from "./jobState";

const row = {
  id: "11111111-1111-4111-8111-111111111111", thread_id: "22222222-2222-4222-8222-222222222222",
  owner_message_id: "33333333-3333-4333-8333-333333333333", status: "running", attempt: 1,
  error_code: null, reply_message_id: null,
  progress: [{ tool: "get_sales", agent: "alex" }, { tool: "x", agent: "nobody" }, "junk"],
  inbox: null, consumed: ["44444444-4444-4444-8444-444444444444"],
  heartbeat_at: "2026-10-22T10:00:00.000Z", created_at: "2026-10-22T10:00:00.000Z",
};
describe("agent job state", () => {
  it("parses a row and drops malformed progress", () => {
    const job = toAgentJob(row);
    expect(job.progress).toEqual([{ tool: "get_sales", agent: "alex" }]);
    expect(job.inbox).toEqual([]);
    expect(job.consumed).toHaveLength(1);
  });
  it("shows a silent, stale job as failed with a timeout instead of spinning forever", () => {
    const job = toAgentJob(row);
    const at = Date.parse(row.heartbeat_at);
    expect(effectiveAgentJob(job, at + AGENT_JOB_STALE_MS - 1).status).toBe("running");
    expect(effectiveAgentJob(job, at + AGENT_JOB_STALE_MS + 1)).toMatchObject({ status: "failed", errorCode: "timeout" });
    expect(effectiveAgentJob({ ...job, status: "done" }, at + 10 * AGENT_JOB_STALE_MS).status).toBe("done");
  });
  it("rejects rows that are not jobs", () => {
    expect(() => toAgentJob({ ...row, status: "weird" })).toThrow();
  });
});

it("rehydrates only the public answer and provider summary for a durable job, without marking its physical slice stale",()=>{
  const job=toAgentJob({...row,durable_run_id:"77777777-7777-4777-8777-777777777777",progress:[
    {kind:"live_view",text:"Research result",presentations:[{offset:15,block:{type:"rich_presentation"}}],transcript:["private"]},
    {kind:"thinking",summary:"Checking figures"}, {tool:"run_sql",agent:"alex"}]});
  expect(job.liveView).toEqual({text:"Research result",presentations:[{offset:15,block:{type:"rich_presentation"}}]});
  expect(job.thinkingSummary).toBe("Checking figures");
  expect(job.progress).toEqual([{tool:"run_sql",agent:"alex"}]);
  expect(effectiveAgentJob(job,Date.parse(row.heartbeat_at)+AGENT_JOB_STALE_MS*10).status).toBe("running");
});
