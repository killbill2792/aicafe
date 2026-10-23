import { describe, expect, it, vi, beforeEach } from "vitest";

const THREAD = "11111111-1111-4111-8111-111111111111";
const JOB = "55555555-5555-4555-8555-555555555555";
const NEXT = "66666666-6666-4666-8666-666666666666";
const job = (id: string, owner = "msg-1") => ({ id, threadId: THREAD, ownerMessageId: owner, status: "running", attempt: 1,
  errorCode: null, replyMessageId: null, progress: [], inbox: [], consumed: [], heartbeatAt: "", createdAt: "" });
const fake = vi.hoisted(() => ({
  mode: "started" as string, startFails: false, continuation: null as unknown,
  finished: [] as Array<{ id: string; status: string; errorCode?: string }>,
  steps: [] as Array<{ tool: string }>, loopArgs: [] as Array<Record<string, unknown>>,
  followUps: [] as Array<{ id: string; text: string }>, kept: 0,
}));
vi.mock("@/lib/ai/agent/flags", () => ({ chatExperienceFlags: () => ({ style: true, jobs: true, memory: false }) }));
vi.mock("@/lib/ai/agent/jobs.server", () => ({
  startAgentJob: async () => { if (fake.startFails) throw new Error("rpc"); return { mode: fake.mode, job: job(JOB) }; },
  recordAgentJobStep: async (_id: string, step: { tool: string }) => { fake.steps.push(step); },
  takeAgentJobInbox: async () => fake.followUps.splice(0),
  finishAgentJob: async (id: string, outcome: { status: string; errorCode?: string }) => {
    fake.finished.push({ id, ...outcome });
    const continuation = fake.continuation; fake.continuation = null;
    return { continuation };
  },
  readOwnerMessage: async (_s: unknown, _t: string, id: string) => ({ id, threadId: THREAD, role: "owner",
    contentType: "text", text: "and tomorrow?", blocks: null, grounding: null, clientMessageId: "k2" }),
  keepTurnAlive: (work: Promise<unknown>) => { fake.kept++; void work; },
}));
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  ConversationApiError: class extends Error { constructor(public status: number, public code: string) { super(code); } },
  authenticatedConversationContext: async () => ({
    scope: { businessId: "business-1", ownerUserId: "owner-1" },
    service: {
      getThread: async () => ({ id: THREAD, title: "Conversation" }),
      addOwnerMessage: async (_id: string, key: string, text: string) => ({ id: "msg-1", threadId: THREAD,
        role: "owner", contentType: "text", text, blocks: null, grounding: null, clientMessageId: key,
        createdAt: "2026-10-22T10:00:00.000Z" }),
      listMessages: async () => ({ items: [], nextOffset: null }),
    },
  }),
}));
vi.mock("@/lib/ai/conversations/enabled.server", () => ({
  isSupervisorChatConfigured: () => true, getSupervisorChatReadiness: async () => ({ enabled: true, reason: null }) }));
vi.mock("@/lib/ai/conversations/replyWriter.server", () => ({ getExistingSupervisorReply: async () => null }));
vi.mock("@/lib/ai/cafeTools.server", () => ({
  createAuthenticatedCafeTools: async () => ({}),
  readSupervisorCafeIdentity: async () => ({ asOf: "2026-10-21", timezone: "UTC", cafeName: "Test" }) }));
vi.mock("@/lib/ai/conversations/usage.server", () => ({ labelSupervisorThread: async () => {}, assertOwnerAgentTurnAvailable: async () => {} }));
vi.mock("@/lib/ai/agent/loop.server", () => ({
  runAgentTurn: async (args: Record<string, unknown> & { onTool?: (n: string, a: string) => void;
    onDelta?: (d: string) => void; takeFollowUps?: (max: number) => Promise<Array<{ id: string }>> }) => {
    fake.loopArgs.push(args);
    args.onTool?.("get_sales", "alex");
    const absorbed = args.takeFollowUps ? await args.takeFollowUps(5) : [];
    args.onDelta?.("Sales are up.");
    return { text: "Sales are up.", endReason: "complete", status: { status: "complete", missing: [] },
      results: [], unverified: [], usage: { modelCalls: 1, toolCalls: 1, inputTokens: 1, cachedTokens: 0, outputTokens: 1, latencyMs: 1 },
      ...(absorbed.length ? { absorbedOwnerMessageIds: absorbed.map(m => m.id) } : {}) };
  },
}));
vi.mock("@/lib/ai/agent/persist.server", () => ({
  AgentReplyTooLongError: class extends Error {}, AgentReplyStorageError: class extends Error {},
  AgentEmptyReplyError: class extends Error {},
  persistAgentReply: async (_s: unknown, owner: { id: string }) => ({ id: "reply-" + owner.id, grounding: { status: "verified" }, blocks: [] }),
  recordAgentTurnUsage: async () => {},
}));
import { POST } from "./route";

const post = () => POST(new Request("http://localhost:3000/api/ai/threads/" + THREAD + "/agent", {
  method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
  body: JSON.stringify({ clientMessageId: "22222222-2222-4222-8222-222222222222", text: "Sales?", locale: "en" }),
}), { params: Promise.resolve({ threadId: THREAD }) });
const events = (body: string) => [...body.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map(m => ({ type: m[1], data: JSON.parse(m[2]) }));

beforeEach(() => {
  fake.mode = "started"; fake.startFails = false; fake.continuation = null; fake.finished = [];
  fake.steps = []; fake.loopArgs = []; fake.followUps = []; fake.kept = 0;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("agent route with CHAT_JOBS on", () => {
  it("acknowledges first, streams progress, keeps the turn alive and finishes the job", async () => {
    const out = events(await (await post()).text());
    expect(out[0]).toEqual({ type: "ack", data: { jobId: JOB, mode: "started" } });
    expect(out.map(e => e.type)).toEqual(["ack", "tool", "delta", "done"]);
    expect(out.at(-1)!.data).toMatchObject({ jobId: JOB, absorbedOwnerMessageIds: [] });
    expect(fake.kept).toBe(1);
    expect(fake.steps).toEqual([{ tool: "get_sales", agent: "alex" }]);
    expect(fake.finished).toEqual([{ id: JOB, status: "done", replyMessageId: "reply-msg-1" }]);
    expect(fake.loopArgs[0]).toMatchObject({ style: true });
    expect(typeof fake.loopArgs[0].takeFollowUps).toBe("function");
  });
  it("folds a mid-run follow-up into the same answer", async () => {
    fake.followUps = [{ id: "77777777-7777-4777-8777-777777777777", text: "and oat milk?" }];
    const out = events(await (await post()).text());
    expect(out.at(-1)!.data.absorbedOwnerMessageIds).toEqual(["77777777-7777-4777-8777-777777777777"]);
    expect(fake.finished).toEqual([{ id: JOB, status: "done", replyMessageId: "reply-msg-1",
      absorbedOwnerMessageIds: ["77777777-7777-4777-8777-777777777777"] }]);
  });
  it("attaches a message sent while a turn is running and closes at once", async () => {
    fake.mode = "attached";
    const out = events(await (await post()).text());
    expect(out).toEqual([{ type: "ack", data: { jobId: JOB, mode: "attached" } }]);
    expect(fake.loopArgs).toHaveLength(0);
  });
  it("says so in one line when the inbox is full", async () => {
    fake.mode = "busy";
    const out = events(await (await post()).text());
    expect(out.map(e => e.type)).toEqual(["ack", "error"]);
    expect(out[1].data).toMatchObject({ code: "agent_busy", retryable: true });
  });
  it("answers late follow-ups in a continuation on the same stream", async () => {
    fake.continuation = job(NEXT, "msg-2");
    const out = events(await (await post()).text());
    expect(out.map(e => e.type)).toEqual(["ack", "tool", "delta", "done", "ack", "tool", "delta", "done"]);
    expect(out[4].data).toMatchObject({ jobId: NEXT, mode: "continuation", ownerMessageId: "msg-2" });
    expect(fake.finished.map(f => f.id)).toEqual([JOB, NEXT]);
    expect(fake.loopArgs[1]).toMatchObject({ ownerText: "and tomorrow?" });
  });
  it("still answers inline when the jobs table is unavailable", async () => {
    fake.startFails = true;
    const out = events(await (await post()).text());
    expect(out.map(e => e.type)).toEqual(["tool", "delta", "done"]);
    expect(fake.finished).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("agent_job_start_failed");
  });
});
