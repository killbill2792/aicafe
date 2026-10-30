import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({
  usage:vi.fn(),translate:vi.fn(),pos:vi.fn(),stored:vi.fn(),
  alerts:vi.fn(),match:vi.fn(),home:vi.fn(),operations:vi.fn(),project:vi.fn(),
}));
vi.mock("next-intl/server",()=>({
  getLocale:vi.fn(async()=>"en"),getTranslations:mocks.translate,
}));
vi.mock("@/lib/data/usageVariance.server",()=>({readUsageVariance:mocks.usage}));
vi.mock("@/lib/data/getPosConnectionStatus",()=>({getPosConnectionStatus:mocks.pos}));
vi.mock("@/lib/data/operatingTasks",()=>({readPersistedOperatingTasks:mocks.stored}));
vi.mock("@/lib/data/getAlerts",()=>({getOpenAlerts:mocks.alerts}));
vi.mock("@/lib/data/getCatalogMatchReview",()=>({getCatalogMatchReview:mocks.match}));
vi.mock("@/lib/supabase/client",()=>({isSupabaseConfigured:()=>true}));
vi.mock("@/lib/viewmodels/homeViewModel",()=>({buildHomeViewModel:mocks.home}));
vi.mock("@/lib/viewmodels/operationsTeam",()=>({
  buildOperationsTeamViewModel:mocks.operations,projectOperatingTasks:mocks.project,
}));
vi.mock("@/lib/viewmodels/period",()=>({daysForPeriod:()=>[]}));
vi.mock("@/lib/data/getSnapshot",()=>({getSnapshot:vi.fn()}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:vi.fn()}));
vi.mock("@/lib/pos/square/oauth",()=>({isSquareConfigured:()=>false}));
vi.mock("@/components/home/GettingStartedCard",()=>({gettingStartedAttention:()=>[]}));

import { getAttentionItems } from "./getAttentionItems.server";

const snapshot={business:{id:"business-a"},todayDateStr:"2026-10-29"};
const menu={};
function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise=new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}

beforeEach(()=>{
  vi.clearAllMocks();
  mocks.translate.mockResolvedValue((key:string)=>key);
  mocks.home.mockReturnValue({
    isGettingStarted:false,missingCategories:[],coverage:{actualDays:1,expectedDays:1},
  });
  mocks.operations.mockReturnValue({needsYou:[],handled:[],watching:[]});
  mocks.project.mockReturnValue({needsYou:[],handled:[],watching:[]});
});

describe("Home and chat attention reads",()=>{
  it("starts independent reads together and does not scan weekly order lines",async()=>{
    const pos=deferred<{status:string;provider:string}>();
    const stored=deferred<[]>();
    const alerts=deferred<[]>();
    const match=deferred<[]>();
    mocks.pos.mockReturnValue(pos.promise);
    mocks.stored.mockReturnValue(stored.promise);
    mocks.alerts.mockReturnValue(alerts.promise);
    mocks.match.mockReturnValue(match.promise);

    const pending=getAttentionItems({snapshot:snapshot as never,menu:menu as never,locale:"en"});
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.pos).toHaveBeenCalledTimes(1);
    expect(mocks.stored).toHaveBeenCalledWith("business-a");
    expect(mocks.alerts).toHaveBeenCalledTimes(1);
    expect(mocks.match).toHaveBeenCalledTimes(1);
    expect(mocks.usage).not.toHaveBeenCalled();

    pos.resolve({status:"active",provider:"toast"});
    stored.resolve([]);
    alerts.resolve([]);
    match.resolve([]);
    expect(await pending).toEqual([]);
  });

  it("preserves independent failure notices without waiting for usage data",async()=>{
    mocks.pos.mockResolvedValue({status:"active",provider:"toast"});
    mocks.stored.mockResolvedValue([]);
    mocks.alerts.mockRejectedValue(new Error("alerts unavailable"));
    mocks.match.mockRejectedValue(new Error("matches unavailable"));

    const items=await getAttentionItems({snapshot:snapshot as never,menu:menu as never,locale:"en"});
    expect(items.map(item=>item.id)).toEqual(["alerts-unavailable","match-unavailable"]);
    expect(mocks.usage).not.toHaveBeenCalled();
  });
});
