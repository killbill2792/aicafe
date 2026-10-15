import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({
  load:vi.fn(), draft:vi.fn(), digest:vi.fn(), optimizer:vi.fn(), owner:vi.fn(),
}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/scheduling/planInput.server",()=>({
  loadOliviaWeekFromSavedStaff:mocks.load,
}));
vi.mock("@/lib/scheduling/planDrafts.server",()=>({
  createOliviaDraftFromTrustedSnapshot:mocks.draft,
  oliviaSnapshotDigest:mocks.digest,
}));
vi.mock("@/lib/calc/scheduling/plannerEngine",()=>({
  optimizeOliviaWeek:mocks.optimizer,
}));
vi.mock("@/lib/scheduling/foundation.server",()=>({
  requireSchedulingOwner:mocks.owner,
}));

import { previewOliviaWeek, saveOliviaWeekDraft } from "./oliviaPlanning";

const businessId="10000000-0000-4000-8000-000000000001";
const requestKey="20000000-0000-4000-8000-000000000002";
const digest="a".repeat(64);
const input={
  horizonStart:"2026-10-12",
  locations:[{id:"loc",timezone:"UTC"}],
  employees:[{id:"emp",displayName:"Sarah",isOwner:undefined}],
  coverage:[],
};
const saved={ok:true,businessId,input,sourceFingerprint:"b".repeat(64),locationNames:{loc:"Main Café"},
  warnings:[],blockers:[]};
const args={week:"2026-10-12",objective:"balanced",
  expectedRevision:0,expectedSourceDigest:digest,requestKey};

describe("Olivia preview/draft server action safety",()=>{
  beforeEach(()=>{
    vi.resetAllMocks();
    mocks.load.mockResolvedValue(saved);
    mocks.digest.mockReturnValue(digest);
    mocks.optimizer.mockReturnValue({status:"unproven",scenarios:[]});
    mocks.draft.mockResolvedValue({ok:true,seriesId:businessId,revision:1,
      revisionId:requestKey,replayed:false});
  });
  it("rejects forged staffing fields and malformed optimistic digest",async()=>{
    expect(await saveOliviaWeekDraft({...args,business_id:businessId}))
      .toEqual({ok:false,error:"invalid_input"});
    expect(await saveOliviaWeekDraft({...args,expectedSourceDigest:"bogus"}))
      .toEqual({ok:false,error:"invalid_input"});
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("never saves a different staff snapshot than the owner previewed",async()=>{
    mocks.digest.mockReturnValue("b".repeat(64));
    expect(await saveOliviaWeekDraft(args))
      .toEqual({ok:false,error:"source_changed"});
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("preserves tenant binding, week and stable request ID through internal draft service",async()=>{
    const result=await saveOliviaWeekDraft(args);
    expect(result).toMatchObject({ok:true,revision:1});
    expect(mocks.draft).toHaveBeenCalledWith({
      horizonStart:"2026-10-12",objective:"balanced",
      expectedRevision:0,requestKey,
    },input,businessId,"b".repeat(64));
  });
  it("does not fabricate owner-hours savings for an unlinked owner",async()=>{
    expect(await saveOliviaWeekDraft({...args,objective:"owner_time"}))
      .toEqual({ok:false,error:"owner_link_missing"});
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("returns actionable missing-coverage blocker and never drafts",async()=>{
    mocks.load.mockResolvedValue({...saved,blockers:["Set confirmed coverage."]});
    expect(await saveOliviaWeekDraft(args))
      .toEqual({ok:false,error:"missing_coverage"});
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("previews a verifiable digest and display names without staff-record writes",async()=>{
    const result=await previewOliviaWeek({week:"2026-10-12"});
    expect(result).toMatchObject({
      ok:true,sourceDigest:digest,
      employees:{emp:"Sarah"},locations:{loc:"UTC"},
      locationNames:{loc:"Main Café"},
    });
    expect(mocks.draft).not.toHaveBeenCalled();
  });
  it("does not preview plans lacking required confirmed staffing data",async()=>{
    mocks.load.mockResolvedValue({...saved,blockers:["Enter required coverage."]});
    expect(await previewOliviaWeek({week:"2026-10-12"}))
      .toEqual({ok:false,error:"Enter required coverage."});
    expect(mocks.optimizer).not.toHaveBeenCalled();
  });
});
