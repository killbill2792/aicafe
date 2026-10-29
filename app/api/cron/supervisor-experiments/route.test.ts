import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
  events:[] as string[],
  seen:vi.fn(),
  transition:vi.fn(),
  sampled:[] as string[],
  incomplete:[] as string[],
}));
vi.mock("date-fns-tz",()=>({formatInTimeZone:()=> "2026-11-15"}));
vi.mock("@/lib/ai/supervisor/loop/engine",async origin=>({
  ...await origin<object>(),
  monitorLoop:async(_scope:unknown,_registry:unknown,_repo:unknown,_proposal:unknown,day:string)=>{
    mocks.events.push("monitor:"+day);
    mocks.seen(day);
    return {status:"complete",result:{coveredDays:7},recommendation:"keep",source:"order_lines"};
  },
}));
vi.mock("@/lib/ai/supervisor/loop/supabase.server",()=>({
  SupabaseLoopRepository:class {
    samples=async()=>mocks.sampled.map(businessDate=>({businessDate,source:"test",
      observation:{values:{primary:{value:1,coverage:mocks.incomplete.includes(businessDate)?0:1}},baseline:{}}}));
    transition=async(_scope:unknown,_id:string,_rev:number,action:string)=>{
      mocks.events.push("transition:"+action);
      return mocks.transition(action);
    };
  },
}));
vi.mock("@/lib/ai/supervisor/loop/priceExperiment.server",()=>({supervisorLoopRegistry:{}}));
const row={
  id:"b1d0a764-3b31-4833-b800-3c8df90f45ac",
  business_id:"a0000000-0000-4000-8000-000000000999",
  owner_user_id:"a0000000-0000-4000-8000-000000000998",
  thread_id:"a0000000-0000-4000-8000-000000000997",
  capability_id:"alex.drink_price_experiment.v1",capability_version:1,
  canonical_effect_payload:{},effect_hash:"f".repeat(64),baseline:{},
  monitor_spec:{durationDays:7,metricScope:"latte"},
  status:"manual_confirmed",revision:3,locale:"en",
  monitoring_start_date:"2026-10-01",created_at:"2026-09-30T00:00:00Z",
};
const database={
  from:(table:string)=>{
    if(table==="supervisor_proposals")return {
      select:()=>({
        in:()=>({not:()=>({order:()=>({order:()=>({
          limit:async()=>({data:[row],error:null}),
        })})})}),
      }),
      update:()=>({
        eq:()=>({eq:()=>({eq:()=>({eq:()=>({
          in:async()=>({error:null}),
        })})})}),
      }),
    };
    if(table==="memberships")return {
      select:()=>({eq:()=>({eq:()=>({maybeSingle:async()=>({
        data:{role:"owner"},error:null,
      })})})}),
    };
    if(table==="businesses")return {
      select:()=>({eq:()=>({single:async()=>({
        data:{timezone:"America/Los_Angeles"},error:null,
      })})}),
    };
    throw Error("Unexpected table "+table);
  },
};
vi.mock("@/lib/supabase/admin",()=>({
  createAdminSupabaseClient:()=>database,
}));
import {GET} from "./route";
describe("delayed Supervisor monitor archival",()=>{
  beforeEach(()=>{
    mocks.events.length=0;mocks.seen.mockClear();mocks.transition.mockReset();
    process.env.CRON_SECRET="test-secret";
    mocks.transition.mockResolvedValue({});
    mocks.sampled=[];mocks.incomplete=[];
    row.monitor_spec={durationDays:7,metricScope:"latte"};row.monitoring_start_date="2026-10-01";
  });
  it("regenerates all actual-window samples and the terminal report before archiving a delayed proposal",async()=>{
    const res=await GET(new Request("https://cafe.test/api/cron/supervisor-experiments",{
      headers:{authorization:"Bearer test-secret"},
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({checked:1,failed:0});
    expect(mocks.seen).toHaveBeenCalledWith("2026-10-07");
    expect(mocks.seen).toHaveBeenCalledWith("2026-11-14");
    expect(mocks.events.at(-1)).toBe("transition:finish_monitor");
    expect(mocks.events.indexOf("monitor:2026-11-14")).toBeLessThan(
      mocks.events.indexOf("transition:finish_monitor"));
  });
  const run=async()=>{
    const res=await GET(new Request("https://cafe.test/api/cron/supervisor-experiments",{
      headers:{authorization:"Bearer test-secret"},
    }));
    expect(res.status).toBe(200);
  };
  const days=(from:string,n:number)=>Array.from({length:n},(_,i)=>new Date(Date.parse(from+"T12:00:00Z")+i*86_400_000).toISOString().slice(0,10));
  it("re-reads every day of a short window, sampled or not",async()=>{
    mocks.sampled=days("2026-10-01",7);
    await run();
    expect(mocks.seen).toHaveBeenCalledWith("2026-10-03");
  });
  it("on a long goal, skips old complete days but re-reads incomplete ones",async()=>{
    row.monitor_spec={durationDays:30,metricScope:"goal:orders"};
    mocks.sampled=days("2026-10-01",30);mocks.incomplete=["2026-10-05"];
    await run();
    expect(mocks.seen).not.toHaveBeenCalledWith("2026-10-03");
    expect(mocks.seen).toHaveBeenCalledWith("2026-10-05");
    // The terminal report is still published before archiving.
    expect(mocks.seen).toHaveBeenCalledWith("2026-11-14");
    expect(mocks.events.at(-1)).toBe("transition:finish_monitor");
  });
  it("re-reads every day of a long goal once a week, on its start weekday",async()=>{
    // 15 November 2026 and 4 October 2026 are both Sundays.
    row.monitor_spec={durationDays:30,metricScope:"goal:orders"};row.monitoring_start_date="2026-10-04";
    mocks.sampled=days("2026-10-04",30);
    await run();
    expect(mocks.seen).toHaveBeenCalledWith("2026-10-06");
  });
});
