import {beforeEach,describe,expect,it,vi} from "vitest";
import {eventFinalNarrative} from "./eventFinalReport.server";
import {runAgentTurn} from "@/lib/ai/agent/loop.server";
import {assertCafeAiAccess} from "@/lib/access/access.server";

vi.mock("server-only",()=>({}));
vi.mock("@/lib/ai/agent/loop.server",()=>({runAgentTurn:vi.fn()}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:vi.fn()}));

let saved:Record<string,unknown>|null=null;
const reads:Record<string,unknown>={
  supervisor_reports:null,
  memberships:{role:"owner"},
  businesses:{timezone:"America/Los_Angeles",is_demo:false},
};
const db={from:(table:string)=>{
  const q={
    select:()=>q,eq:()=>q,
    maybeSingle:async()=>({data:table==="supervisor_reports"?
      saved?{report:saved}:null:reads[table],error:null}),
  };
  return q;
}};
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>db}));

const scope={businessId:"11111111-1111-4111-8111-111111111111",
  ownerUserId:"22222222-2222-4222-8222-222222222222",
  threadId:"33333333-3333-4333-8333-333333333333",locale:"en" as const};
const result={
  startDate:"2026-10-31",endDate:"2026-10-31",
  observedDays:1,expectedDays:1,checklist:{total:2,done:1,dismissed:0},
  days:[{date:"2026-10-31",actualCents:5000,typicalCents:4000,
    hours:[{hourLocal:12,actualCents:500,usualCents:400,changePercent:25}]}],
  caveat:"Comparison is observational, not evidence that an event caused a change.",
};
beforeEach(()=>{
  saved=null;reads.memberships={role:"owner"};
  vi.resetAllMocks();
  vi.mocked(runAgentTurn).mockResolvedValue({text:"AI-written, evidence-backed report."} as Awaited<ReturnType<typeof runAgentTurn>>);
});
describe("event morning-after narrative",()=>{
  it("uses the one agent and reuses the exact saved text for the same evidence",async()=>{
    const first=await eventFinalNarrative(scope,"44444444-4444-4444-8444-444444444444",
      ["Halloween"],"Ready for the holiday",result,"complete");
    expect(first?.text).toBe("AI-written, evidence-backed report.");
    expect(assertCafeAiAccess).toHaveBeenCalledWith(scope.businessId);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAgentTurn).mock.calls[0][0].toolNames).toEqual([]);
    saved={reportFactsHash:first!.hash,reportText:first!.text};
    expect(await eventFinalNarrative(scope,"44444444-4444-4444-8444-444444444444",
      ["Halloween"],"Ready for the holiday",result,"complete")).toEqual(first);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });
  it("refuses a paid model call when the current owner is no longer eligible",async()=>{
    reads.memberships={role:"staff"};
    await expect(eventFinalNarrative(scope,"44444444-4444-4444-8444-444444444444",
      ["Halloween"],"Ready for the holiday",result,"complete")).rejects.toThrow("owner_required");
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
  it("never invents a narrative when the provider returns empty text",async()=>{
    vi.mocked(runAgentTurn).mockResolvedValue({text:""} as Awaited<ReturnType<typeof runAgentTurn>>);
    expect(await eventFinalNarrative(scope,"44444444-4444-4444-8444-444444444444",
      ["Halloween"],"Ready for the holiday",result,"insufficient_evidence")).toBeNull();
  });
});
