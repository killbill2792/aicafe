import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {recordBriefRun,type BriefRunRecord} from "./briefRuns.server";

const record:BriefRunRecord={businessId:"cafe-a",localDate:"2026-11-03",ownerKey:"owner-a",
  channel:"in_app",runKind:"scheduled",step:"brief",outcome:"sent",reason:"posted"};
const now=new Date("2026-11-03T14:00:00.000Z");

describe("morning brief run ledger",()=>{
  it("fails the caller when the durable run upsert fails instead of reporting log-only success",async()=>{
    const upsert=vi.fn(async()=>({error:{code:"XX000"}}));
    const db={from:vi.fn(()=>({upsert}))} as unknown as SupabaseClient;
    const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    await expect(recordBriefRun(db,record,now)).rejects.toThrow("brief_run_persistence_failed");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      business_id:"cafe-a",local_date:"2026-11-03",owner_key:"owner-a",
      channel:"in_app",run_kind:"scheduled",outcome:"sent",reason:"posted",
    }),{onConflict:"business_id,local_date,owner_key,channel,run_kind"});
    expect(warn).toHaveBeenCalledWith("morning_brief_run",expect.objectContaining({
      recorded:"failed",code:"XX000",
    }));
    warn.mockRestore();
  });
});
