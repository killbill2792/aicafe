import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  reply: { id: "reply-1", grounding: { status: "verified" }, blocks: [{ type:"text",text:"Here is the answer." }] },
  writes: 0, usageChecks: 0, quotaExhausted: false, ownerWrites: 0,
  loopCalls: 0, stored: false, storageFails: false,
  usageRecorded: [] as Array<{modelCalls:number; toolCalls:number}>,
  queued: [] as Array<{text:string;endReason:string;resetChars?:number;results?: Array<Record<string,unknown>>}>,
}));
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  ConversationApiError: class extends Error {
    constructor(public status: number, public code: string) { super(code); }
  },
  authenticatedConversationContext: async () => ({
    scope: { businessId:"business-1", ownerUserId:"owner-1" },
    service: {
      getThread: async () => ({ id:"11111111-1111-4111-8111-111111111111", title:"Conversation" }),
      addOwnerMessage: async (_id:string,key:string,text:string) => {
        fake.ownerWrites++;
        return ({
        id:"msg-1", threadId:"11111111-1111-4111-8111-111111111111",
        role:"owner", contentType:"text", text, blocks:null, grounding:null,clientMessageId:key,
      });
      },
      listMessages: async () => ({ items: [], nextOffset:null }),
    },
  }),
}));
vi.mock("@/lib/ai/conversations/enabled.server", () => ({
  isSupervisorChatConfigured: () => true,
  getSupervisorChatReadiness: async () => ({ enabled:true,reason:null }),
}));
vi.mock("@/lib/ai/conversations/replyWriter.server", () => ({
  getExistingSupervisorReply: async () => fake.stored ? fake.reply : null,
}));
vi.mock("@/lib/ai/cafeTools.server", () => ({
  createAuthenticatedCafeTools: async () => ({}),
  readSupervisorCafeIdentity: async () => ({ asOf:"2026-10-21",timezone:"UTC",cafeName:"Test" }),
}));
vi.mock("@/lib/ai/conversations/usage.server", () => ({
  labelSupervisorThread: async () => {},
  assertOwnerAgentTurnAvailable: async () => {
    fake.usageChecks++;
    if (fake.quotaExhausted) {
      const { ConversationApiError } = await import("@/lib/ai/conversations/auth.server");
      throw new ConversationApiError(429, "owner_usage_limit_reached");
    }
  },
}));
vi.mock("@/lib/ai/agent/loop.server", () => ({
  runAgentTurn: async (args: {onDelta?: (delta:string)=>void;onReset?: (count:number)=>void}) => {
    fake.loopCalls++;
    const next = fake.queued.shift() ?? {text:"Here is the answer.",endReason:"complete"};
    if (next.resetChars) {
      args.onDelta?.("Wrong");
      args.onReset?.(next.resetChars);
    }
    if (next.text) args.onDelta?.(next.text);
    const results = next.results ?? [{source:"menu_items",period:null,missing:[]}];
    return { text:next.text,endReason:next.endReason,status:{status:"complete",missing:[]},
      results, unverified:[],
      usage:{modelCalls:1,toolCalls:1,inputTokens:12,cachedTokens:4,outputTokens:8,latencyMs:15} };
  },
}));
vi.mock("@/lib/ai/agent/persist.server", () => {
  class AgentReplyStorageError extends Error {}
  return {
    AgentReplyTooLongError: class extends Error {},
    AgentReplyStorageError,
    AgentEmptyReplyError: class extends Error {},
    persistAgentReply: async () => {
      fake.writes++;
      if (fake.storageFails) throw new AgentReplyStorageError();
      fake.stored = true; return fake.reply;
    },
    recordAgentTurnUsage: async (_scope:unknown,_owner:unknown,turn:{
      usage:{modelCalls:number;toolCalls:number}
    }) => { fake.usageRecorded.push({
      modelCalls:turn.usage.modelCalls,toolCalls:turn.usage.toolCalls,
    }); },
  };
});
import { POST } from "./route";

describe("default authenticated streaming agent route", () => {
  it("streams a complete turn and emits done after successful persistence", async () => {
    fake.writes = 0; fake.usageChecks = 0; fake.quotaExhausted = false;
    fake.ownerWrites=0; fake.loopCalls=0; fake.stored=false; fake.queued=[];
    fake.usageRecorded=[];fake.storageFails=false;
    const url = "http://localhost:3000/api/ai/threads/11111111-1111-4111-8111-111111111111/agent";
    const request = new Request(url, {method:"POST",
      headers:{"origin":"http://localhost:3000","content-type":"application/json"},
      body:JSON.stringify({clientMessageId:"22222222-2222-4222-8222-222222222222",
        text:"How are we doing?",locale:"en"})});
    const response = await POST(request,{params:Promise.resolve({
      threadId:"11111111-1111-4111-8111-111111111111"})});
    const output = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(output).toContain("event: delta");
    expect(output).toContain("event: done");
    expect(output).toContain('"status":"verified"');
    expect(output).not.toContain("event: error");
    expect(fake.writes).toBe(1);
    expect(fake.usageChecks).toBe(1);
    expect(fake.usageRecorded).toEqual([{modelCalls:1,toolCalls:1}]);
  });
  it("rejects quota before saving the owner message", async () => {
    fake.writes=0; fake.ownerWrites=0; fake.usageChecks=0; fake.loopCalls=0;
    fake.quotaExhausted=true; fake.stored=false; fake.queued=[];
    try {
      const response = await POST(new Request(
        "http://localhost:3000/api/ai/threads/11111111-1111-4111-8111-111111111111/agent", {
          method:"POST", headers:{"origin":"http://localhost:3000","content-type":"application/json"},
          body:JSON.stringify({clientMessageId:"22222222-2222-4222-8222-222222222222",
            text:"Menu?",locale:"en"}),
        }), {params:Promise.resolve({threadId:"11111111-1111-4111-8111-111111111111"})});
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({error:"owner_usage_limit_reached"});
      expect(fake.ownerWrites).toBe(0);
      expect(fake.loopCalls).toBe(0);
      expect(fake.writes).toBe(0);
      expect(fake.usageChecks).toBe(1);
      expect(fake.usageRecorded).toEqual([]);
    } finally { fake.quotaExhausted=false; }
  });
  it("does not save a blank interrupted turn and retries the same clientMessageId", async () => {
    fake.writes=0; fake.ownerWrites=0; fake.usageChecks=0; fake.loopCalls=0;
    fake.quotaExhausted=false; fake.stored=false;
    fake.storageFails=false;fake.usageRecorded=[];
    fake.queued=[
      {text:"  ",endReason:"provider_error",results:[]},
      {text:"Recovered answer.",endReason:"complete"},
    ];
    const request = () => new Request(
      "http://localhost:3000/api/ai/threads/11111111-1111-4111-8111-111111111111/agent", {
        method:"POST",headers:{"origin":"http://localhost:3000","content-type":"application/json"},
        body:JSON.stringify({clientMessageId:"22222222-2222-4222-8222-222222222222",
          text:"How are we doing?",locale:"en"}),
      });
    const context = {params:Promise.resolve({threadId:"11111111-1111-4111-8111-111111111111"})};
    const first = await (await POST(request(),context)).text();
    expect(first).toContain('event: error');
    expect(first).toContain('"code":"agent_turn_failed"');
    expect(first).toContain('"retryable":true');
    expect(first).not.toContain('event: done');
    expect(fake.writes).toBe(0);
    expect(fake.stored).toBe(false);
    expect(fake.usageRecorded).toEqual([{modelCalls:1,toolCalls:1}]);
    const second = await (await POST(request(),context)).text();
    expect(second).toContain("event: done");
    expect(second).not.toContain('"replayed":true');
    expect(fake.loopCalls).toBe(2);
    expect(fake.ownerWrites).toBe(2);
    expect(fake.writes).toBe(1);
    expect(fake.usageRecorded).toHaveLength(2);
  });
  it("persists interrupted nonempty prose as non-verified", async () => {
    // End-to-end persistence status is covered by agent/persist.server.test.ts;
    // route ensures a nonempty interrupted reply still completes its stream.
    fake.writes=0; fake.ownerWrites=0; fake.usageChecks=0; fake.loopCalls=0;
    fake.quotaExhausted=false; fake.stored=false;
    fake.storageFails=false;fake.usageRecorded=[];
    fake.queued=[{text:"Partial text.",endReason:"provider_error"}];
    const response = await POST(new Request(
      "http://localhost:3000/api/ai/threads/11111111-1111-4111-8111-111111111111/agent",{
        method:"POST",headers:{"origin":"http://localhost:3000","content-type":"application/json"},
        body:JSON.stringify({clientMessageId:"22222222-2222-4222-8222-222222222222",
          text:"Sales?",locale:"en"}),
      }),{params:Promise.resolve({threadId:"11111111-1111-4111-8111-111111111111"})});
    const output=await response.text();
    expect(output).toContain("event: done");
    expect(output).not.toContain("event: error");
    expect(fake.writes).toBe(1);
  });

  it("records one usage increment for a failed assistant storage write", async () => {
    fake.writes=0;fake.ownerWrites=0;fake.loopCalls=0;fake.stored=false;
    fake.quotaExhausted=false;fake.storageFails=true;fake.usageRecorded=[];
    fake.queued=[{text:"Persist this.",endReason:"complete"}];
    const response=await POST(new Request(
      "http://localhost:3000/api/ai/threads/11111111-1111-4111-8111-111111111111/agent",{
        method:"POST",headers:{"origin":"http://localhost:3000","content-type":"application/json"},
        body:JSON.stringify({clientMessageId:"22222222-2222-4222-8222-222222222222",
          text:"Menu?",locale:"en"}),
      }),{params:Promise.resolve({threadId:"11111111-1111-4111-8111-111111111111"})});
    const stream=await response.text();
    expect(stream).toContain('"code":"reply_storage_failed"');
    expect(stream).not.toContain("event: done");
    expect(fake.stored).toBe(false);
    expect(fake.usageRecorded).toEqual([{modelCalls:1,toolCalls:1}]);
    fake.storageFails=false;
  });

  it("forwards the reset event so provisional failed text is removed on the client", async () => {
    fake.writes=0;fake.ownerWrites=0;fake.loopCalls=0;
    fake.stored=false;fake.quotaExhausted=false;fake.storageFails=false;fake.usageRecorded=[];
    fake.queued=[{text:"not confirmed.",endReason:"provider_error",resetChars:5}];
    const reply=await POST(new Request(
      "http://localhost:3000/api/ai/threads/11111111-1111-4111-8111-111111111111/agent",{
        method:"POST",headers:{"origin":"http://localhost:3000","content-type":"application/json"},
        body:JSON.stringify({clientMessageId:"22222222-2222-4222-8222-222222222222",
          text:"Menu?",locale:"en"}),
      }),{params:Promise.resolve({threadId:"11111111-1111-4111-8111-111111111111"})});
    const output=await reply.text();
    expect(output).toContain('event: delta\\ndata: {"text":"Wrong"}');
    expect(output).toContain('event: reset\\ndata: {"discardChars":5}');
    expect(output).toContain('event: delta\\ndata: {"text":"not confirmed."}');
    expect(output).toContain('event: done');
    expect(fake.usageRecorded).toHaveLength(1);
  });

});
