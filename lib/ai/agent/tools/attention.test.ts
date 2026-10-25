import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAttentionItems } from "@/lib/attention/getAttentionItems.server";
import { attentionTools } from "./attention";
import type { AgentToolContext } from "./index";

vi.mock("@/lib/attention/getAttentionItems.server",()=>({getAttentionItems:vi.fn()}));
const entries=[
  {id:"alert:a",kind:"missing_bill",source:"alerts",agentId:"leo",title:{key:"Alerts.missingBill",params:{}},
    displayTitle:"Missing invoice",href:"/more/bills",actionLabel:"Add",impactCents:500},
  {id:"unmatched",kind:"unmatched",source:"pos_catalog_matches",agentId:"maya",title:{key:"Home.attentionUnmatched",params:{count:1}},
    displayTitle:"Item needs matching",href:"/menu/import-review",actionLabel:"Match",impactCents:null},
  {id:"task:z",kind:"staff_coverage",source:"operating_tasks",agentId:"olivia",title:{key:"Operations.staffTaskNamed",params:{issue:"Coverage"}},
    displayTitle:"Review the next shift",href:"/staff?tab=schedule",actionLabel:"Fix",impactCents:250},
] as const;
const ctx={asOf:"2026-10-24",locale:"es",timezone:"America/Los_Angeles",tools:{}} as unknown as AgentToolContext;
beforeEach(()=>{vi.clearAllMocks();vi.mocked(getAttentionItems).mockResolvedValue([...entries] as unknown as Awaited<ReturnType<typeof getAttentionItems>>);});
describe("shared attention tool",()=>{
  it("returns exactly the same canonical item ids, agents, and destinations Home receives",async()=>{
    const r=await attentionTools.get_attention_items.execute({},ctx);
    expect(getAttentionItems).toHaveBeenCalledWith({period:"today",locale:"es"});
    expect(r.missing).toEqual([]);
    expect(r.total).toBe(3);
    const items=r.items as typeof entries[number][];
    expect(items.map(row=>[row.id,row.agentId,row.href])).toEqual(
      [entries[0],entries[2],entries[1]].map(row=>[row.id,row.agentId,row.href]));
    expect(JSON.stringify(items)).not.toContain("Dawn");
    expect(items.map(item=>item.displayTitle)).toEqual(
      [entries[0].displayTitle,entries[2].displayTitle,entries[1].displayTitle]);
  });
  it("rejects model-supplied business selectors instead of switching cafés",async()=>{
    await expect(attentionTools.get_attention_items.execute({businessId:"another"},ctx)).rejects.toThrow();
    expect(getAttentionItems).not.toHaveBeenCalled();
  });
  it("marks unavailable usage facts as missing instead of treating zero as verified",async()=>{
    vi.mocked(getAttentionItems).mockResolvedValue([{
      id:"usage-unavailable",kind:"usage-unavailable",source:"home",agentId:"maya",
      title:{key:"Home.attentionUsageUnavailable",params:{}},
      displayTitle:"Usage records temporarily unavailable",href:"/menu/pantry",
      actionLabel:"Review pantry",impactCents:null,
    }] as never);
    const r=await attentionTools.get_attention_items.execute({},ctx);
    expect(r.missing).toContain("usageVarianceUnavailable");
    expect((r.items as {id:string}[]).map(item=>item.id)).toEqual(["usage-unavailable"]);
    expect(r.total).toBe(1);
  });
  it("does not fabricate attention for an empty new café",async()=>{
    vi.mocked(getAttentionItems).mockResolvedValue([]);
    const r=await attentionTools.get_attention_items.execute({},ctx);
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
  });
});
