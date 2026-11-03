import {beforeEach,describe,expect,it,vi} from "vitest";
import {eventFinalNarrative,eventReportFactsHash,eventReportNumericEvidence} from "./eventFinalReport.server";
import {effectHash} from "@/lib/ai/supervisor/loop/engine";
import {checkNumbers} from "@/lib/ai/agent/checkNumbers";
import {runAgentTurn} from "@/lib/ai/agent/loop.server";
import {assertCafeAiAccess} from "@/lib/access/access.server";

vi.mock("server-only",()=>({}));
vi.mock("@/lib/ai/agent/loop.server",()=>({runAgentTurn:vi.fn()}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:vi.fn()}));

let saved:Record<string,unknown>|null=null;
const reads:Record<string,unknown>={
  supervisor_reports:null,
  memberships:{role:"owner"},
  businesses:{timezone:"America/Los_Angeles",currency:"USD",is_demo:false},
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
  reads.businesses={timezone:"America/Los_Angeles",currency:"USD",is_demo:false};
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
  it("preserves numeric results without spending when AI access expires",async()=>{
    vi.mocked(assertCafeAiAccess).mockRejectedValueOnce(new Error("AI access unavailable"));
    expect(await eventFinalNarrative(scope,"44444444-4444-4444-8444-444444444444",
      ["Halloween"],"Ready for the holiday",result,"insufficient_evidence")).toBeNull();
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
  it("supplies typed hourly amounts to the numeric checker and retains warning offsets",async()=>{
    const text="Sales reached 999999, unsupported by the saved day.";
    vi.mocked(runAgentTurn).mockResolvedValueOnce({
      text,provenance:[{text:"999999",start:14,end:20,kind:"number",source:"unchecked"}],
      unverified:[{text:"999999",start:14,end:20,kind:"number"}],
    } as Awaited<ReturnType<typeof runAgentTurn>>);
    const narrative=await eventFinalNarrative(scope,
      "44444444-4444-4444-8444-444444444444",["Halloween"],
      "Ready for the holiday",result,"complete");
    expect(narrative?.text).toBe(text);
    expect(narrative?.provenance).toEqual([{
      text:"999999",start:14,end:20,kind:"number",source:"unchecked",
    }]);
    const args=vi.mocked(runAgentTurn).mock.calls[0][0];
    expect(args.previousEvidence).toEqual([{
      tool:"event_readiness",values:expect.arrayContaining([
        {key:"2026-10-31/actualCents",value:5000,unit:"cents"},
        {key:"2026-10-31/12/actualCents",value:500,unit:"cents"},
        {key:"2026-10-31/12/usualCents",value:400,unit:"cents"},
        {key:"2026-10-31/12/changeBps",value:2500,unit:"bps"},
      ]),
    }]);
  });
  it("never invents a narrative when the provider returns empty text",async()=>{
    vi.mocked(runAgentTurn).mockResolvedValue({text:""} as Awaited<ReturnType<typeof runAgentTurn>>);
    expect(await eventFinalNarrative(scope,"44444444-4444-4444-8444-444444444444",
      ["Halloween"],"Ready for the holiday",result,"insufficient_evidence")).toBeNull();
  });
  it.each([
    ["USD","$50.00","$40.00","$5.00"],
    ["EUR","€50.00","€40.00","€5.00"],
    [null,"50.00","40.00","5.00"],
  ] as const)("formats daily and hourly money for café currency %s, leaving cents only as verifier evidence",
    async(currency,actual,usual,hour)=>{
      reads.businesses={timezone:"America/Los_Angeles",currency,is_demo:false};
      await eventFinalNarrative(scope,"44444444-4444-4444-8444-444444444444",
        ["Halloween"],"Ready for the holiday",result,"complete");
      const args=vi.mocked(runAgentTurn).mock.calls[0][0];
      const serialized=String(args.memoryFacts);
      const facts=JSON.parse(serialized.slice(serialized.indexOf("{")));
      expect(facts.currency).toBe(currency);
      expect(facts.days[0]).toMatchObject({actual,usual,
        hours:[{hour:12,actual:hour,usual:currency===null?"4.00":
          currency==="USD"?"$4.00":"€4.00"}]});
      expect(facts.days[0]).not.toHaveProperty("actualCents");
      expect(facts.days[0].hours[0]).not.toHaveProperty("usualCents");
      expect(serialized).not.toContain("integer cents");
      expect(args.previousEvidence).toEqual(eventReportNumericEvidence(result));
      expect(args.previousEvidence?.[0].values).toContainEqual({
        key:"2026-10-31/actualCents",value:5000,unit:"cents"});
      expect(facts.moneyUnit).toContain(currency===null?"Currency is not set":"already formatted in "+currency);
    });

  it("scales the real Nov 2 totals and hourly cents exactly once",async()=>{
    const day={...result.days[0],actualCents:135844,typicalCents:120605,
      hours:[{hourLocal:7,actualCents:10550,usualCents:6135,changePercent:72}]};
    await eventFinalNarrative(scope,"44444444-4444-4444-8444-444444444444",
      ["Festival"],"Prepare normally",{...result,days:[day]},"complete");
    const serialized=String(vi.mocked(runAgentTurn).mock.calls[0][0].memoryFacts);
    expect(serialized).toContain("$1,358.44");
    expect(serialized).toContain("$1,206.05");
    expect(serialized).toContain("$105.50");
    expect(serialized).toContain("$61.35");
    expect(serialized).not.toContain('"actualCents":135844');
    expect(vi.mocked(runAgentTurn).mock.calls[0][0].previousEvidence?.[0].values)
      .toContainEqual({key:"2026-10-31/7/actualCents",value:10550,unit:"cents"});
  });

  it("invalidates a legacy cached narrative once, then reuses the regenerated text",async()=>{
    const legacy=effectHash({result,status:"complete",planSummary:"Ready for the holiday",
      eventNames:["Halloween"]});
    const modern=eventReportFactsHash(result,"complete","Ready for the holiday",["Halloween"]);
    expect(legacy).not.toBe(modern);
    saved={reportFactsHash:legacy,reportText:"Actual 5000 vs 4000",reportTextOrigin:"model"};
    const updated=await eventFinalNarrative(scope,"44444444-4444-4444-8444-444444444444",
      ["Halloween"],"Ready for the holiday",result,"complete");
    expect(updated?.hash).toBe(modern);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
    saved={reportFactsHash:updated!.hash,reportText:updated!.text,reportTextOrigin:"model",
      reportProvenance:updated!.provenance};
    const reused=await eventFinalNarrative(scope,"44444444-4444-4444-8444-444444444444",
      ["Halloween"],"Ready for the holiday",result,"complete");
    expect(reused).toEqual(updated);
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps correct formatted money verified and rejects unsupported formatted amounts",()=>{
    const evidence=eventReportNumericEvidence(result);
    const good="Actual $50.00 vs usual $40.00; hourly $5.00 vs $4.00.";
    expect(checkNumbers(good,"",[],"en",evidence)).toEqual([]);
    const bad="Actual $999.00 vs usual $40.00.";
    const rejected=checkNumbers(bad,"",[],"en",evidence);
    expect(rejected).toEqual(expect.arrayContaining([
      expect.objectContaining({text:"$999.00",start:bad.indexOf("$999.00")})]));
  });

});
