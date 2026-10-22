import { describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  calls: [60, 40] as number[],
  queriedBusiness: "", queriedOwner: "", queriedAfter: "",
  failure: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  ConversationApiError: class extends Error {
    constructor(public status: number, public code: string) { super(code); }
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    from: (name:string) => {
      if (name !== "ai_usage_events") throw Error("Unexpected table");
      return {
        select: (column:string) => {
          if (column !== "model_call_count") throw Error("Missing call counts");
          return {
            eq: (key:string,value:string) => {
              if(key==="business_id")fake.queriedBusiness=value;
              if(key==="owner_user_id")fake.queriedOwner=value;
              return {
                eq: (key2:string,value2:string) => {
                  if(key2==="owner_user_id")fake.queriedOwner=value2;
                  return {
                    gte: (key3:string,value3:string) => {
                      if(key3==="created_at")fake.queriedAfter=value3;
                      return Promise.resolve(fake.failure?
                        {data:null,error:{code:"query_failed"}}:
                        {data:fake.calls.map(model_call_count=>({model_call_count})),error:null});
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  }),
}));
import { assertOwnerAgentTurnAvailable, MAX_OWNER_AGENT_TURNS_PER_DAY } from "./usage.server";

describe("per-owner agent allowance counts retry model calls", () => {
  const owner={businessId:"business-1",ownerUserId:"owner-1"};
  it("blocks at the call budget even when repeated attempts share one ledger row", async () => {
    fake.failure=false;fake.calls=[MAX_OWNER_AGENT_TURNS_PER_DAY];
    await expect(assertOwnerAgentTurnAvailable(owner)).rejects.toMatchObject({
      status:429,code:"owner_usage_limit_reached",
    });
    expect(fake.queriedBusiness).toBe(owner.businessId);
    expect(fake.queriedOwner).toBe(owner.ownerUserId);
    expect(fake.queriedAfter).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00/);
  });
  it("counts multiple model calls across rows and fails closed on unavailable usage", async () => {
    fake.failure=false;fake.calls=[59,40];
    await expect(assertOwnerAgentTurnAvailable(owner)).resolves.toBeUndefined();
    fake.calls=[59,41];
    await expect(assertOwnerAgentTurnAvailable(owner)).rejects.toMatchObject({status:429});
    fake.failure=true;
    await expect(assertOwnerAgentTurnAvailable(owner)).rejects.toMatchObject({
      status:503,code:"usage_unavailable",
    });
    fake.failure=false;
  });
});
