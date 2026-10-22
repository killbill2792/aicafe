import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  entries: [] as Array<{day:string;model_call_count:number}>,
  queriedBusiness: "", queriedOwner: "", queriedDay: "",
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
          if (column !== "model_call_count") throw Error("Missing model usage");
          return {
            eq: (key:string,value:string) => {
              if(key==="business_id") fake.queriedBusiness=value;
              return {
                eq: (key2:string,value2:string) => {
                  if(key2==="owner_user_id") fake.queriedOwner=value2;
                  return {
                    eq: (key3:string,value3:string) => {
                      if(key3!=="attempt_day") throw Error("Date must be attempt_day");
                      fake.queriedDay=value3;
                      return Promise.resolve(fake.failure
                        ? {data:null,error:{code:"query_failed"}}
                        : {data:fake.entries.filter(e=>e.day===value3).map(e=>({
                            model_call_count:e.model_call_count,
                          })),error:null});
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
import { assertOwnerAgentTurnAvailable, MAX_OWNER_MODEL_CALLS_PER_DAY, ownerModelCallsLimit } from "./usage.server";

describe("owner daily model-call allowance", () => {
  const owner={businessId:"business-1",ownerUserId:"owner-1"};
  afterEach(()=>{
    fake.failure=false; fake.entries=[];
    delete process.env.AI_OWNER_MAX_MODEL_CALLS_PER_DAY;
    vi.useRealTimers();
  });
  it("allows one hundred normal turns with up to three calls each", async () => {
    fake.entries=Array.from({length:100},()=>({day:new Date().toISOString().slice(0,10),model_call_count:3}));
    expect(MAX_OWNER_MODEL_CALLS_PER_DAY).toBe(600);
    await expect(assertOwnerAgentTurnAvailable(owner)).resolves.toBeUndefined();
    expect(fake.queriedBusiness).toBe(owner.businessId);
    expect(fake.queriedOwner).toBe(owner.ownerUserId);
  });
  it("counts same-message retries and blocks at 600 calls", async () => {
    const day=new Date().toISOString().slice(0,10);
    // One ledger row accumulates retry increments for the same message+day.
    fake.entries=[{day,model_call_count:598}];
    await expect(assertOwnerAgentTurnAvailable(owner)).resolves.toBeUndefined();
    fake.entries[0].model_call_count+=2;
    await expect(assertOwnerAgentTurnAvailable(owner)).rejects.toMatchObject({
      status:429,code:"owner_usage_limit_reached",
    });
  });
  it("uses a validated environment override without accepting invalid caps", async () => {
    expect(ownerModelCallsLimit("350")).toBe(350);
    expect(ownerModelCallsLimit("0")).toBe(600);
    expect(ownerModelCallsLimit("NaN")).toBe(600);
    process.env.AI_OWNER_MAX_MODEL_CALLS_PER_DAY="300";
    fake.entries=[{day:new Date().toISOString().slice(0,10),model_call_count:300}];
    await expect(assertOwnerAgentTurnAvailable(owner)).rejects.toMatchObject({status:429});
  });
  it("attributes a retry after UTC midnight to the new day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T23:59:59Z"));
    fake.entries=[{day:"2026-10-21",model_call_count:600}];
    await expect(assertOwnerAgentTurnAvailable(owner)).rejects.toMatchObject({status:429});
    vi.setSystemTime(new Date("2026-10-22T00:00:01Z"));
    fake.entries.push({day:"2026-10-22",model_call_count:1});
    await expect(assertOwnerAgentTurnAvailable(owner)).resolves.toBeUndefined();
    expect(fake.queriedDay).toBe("2026-10-22");
  });
  it("fails closed on missing usage records due to a DB error", async () => {
    fake.failure=true;
    await expect(assertOwnerAgentTurnAvailable(owner)).rejects.toMatchObject({
      status:503,code:"usage_unavailable",
    });
  });
});
