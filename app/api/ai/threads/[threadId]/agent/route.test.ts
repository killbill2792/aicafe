import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  reply: { id: "reply-1", grounding: { status: "verified" }, blocks: [{ type:"text",text:"Here is the answer." }] },
  writes: 0,
}));
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  ConversationApiError: class extends Error {
    constructor(public status: number, public code: string) { super(code); }
  },
  authenticatedConversationContext: async () => ({
    scope: { businessId:"business-1", ownerUserId:"owner-1" },
    service: {
      getThread: async () => ({ id:"11111111-1111-4111-8111-111111111111", title:"Conversation" }),
      addOwnerMessage: async (_id:string,key:string,text:string) => ({
        id:"msg-1", threadId:"11111111-1111-4111-8111-111111111111",
        role:"owner", contentType:"text", text, blocks:null, grounding:null,clientMessageId:key,
      }),
      listMessages: async () => ({ items: [], nextOffset:null }),
    },
  }),
}));
vi.mock("@/lib/ai/conversations/enabled.server", () => ({
  isSupervisorChatConfigured: () => true,
  getSupervisorChatReadiness: async () => ({ enabled:true,reason:null }),
}));
vi.mock("@/lib/ai/conversations/replyWriter.server", () => ({
  getExistingSupervisorReply: async () => null,
}));
vi.mock("@/lib/ai/cafeTools.server", () => ({
  createAuthenticatedCafeTools: async () => ({}),
  readSupervisorCafeIdentity: async () => ({ asOf:"2026-10-21",timezone:"UTC",cafeName:"Test" }),
}));
vi.mock("@/lib/ai/conversations/usage.server", () => ({
  labelSupervisorThread: async () => {},
}));
vi.mock("@/lib/ai/agent/loop.server", () => ({
  runAgentTurn: async (args: {onDelta?: (delta:string)=>void}) => {
    args.onDelta?.("Here is the answer.");
    return { text:"Here is the answer.",endReason:"complete",status:{status:"complete",missing:[]},
      results:[{source:"menu_items",period:null,missing:[]}], unverified:[],
      usage:{modelCalls:1,toolCalls:1,inputTokens:12,cachedTokens:4,outputTokens:8,latencyMs:15} };
  },
}));
vi.mock("@/lib/ai/agent/persist.server", () => ({
  persistAgentReply: async () => { fake.writes++; return fake.reply; },
}));
import { POST } from "./route";

describe("default authenticated streaming agent route", () => {
  it("streams a complete turn and emits done after successful persistence", async () => {
    fake.writes = 0;
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
  });
});
