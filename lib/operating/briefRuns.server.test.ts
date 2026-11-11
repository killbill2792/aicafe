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
  it("writes the final missed outcome once, replacing a waiting row but not rewriting it",async()=>{
    let current:Record<string,unknown>={outcome:"waiting",reason:"yesterday_pos_data_not_complete"};
    const upsert=vi.fn(async(next:Record<string,unknown>,options?:{ignoreDuplicates?:boolean})=>{
      if(!options?.ignoreDuplicates)current=next;
      return {error:null};
    });
    const query:Record<string,unknown>={};
    query.select=()=>query;query.eq=()=>query;
    query.maybeSingle=vi.fn(async()=>({data:current,error:null}));
    query.upsert=upsert;
    const db={from:vi.fn(()=>query)} as unknown as SupabaseClient;
    const missed:BriefRunRecord={...record,step:"schedule",outcome:"skipped",reason:"missed_send_window"};
    await recordBriefRun(db,missed,now,{finalMissed:true});
    expect(current).toMatchObject({outcome:"skipped",reason:"missed_send_window"});
    await recordBriefRun(db,missed,new Date(now.getTime()+5*60_000),{finalMissed:true});
    expect(upsert).toHaveBeenCalledTimes(1);
  });
  it("preserves an existing posted run when a retry observes the same durable message",async()=>{
    const current:Record<string,unknown>={outcome:"sent",reason:"posted"};
    const upsert=vi.fn(async()=>({error:null}));
    const query:Record<string,unknown>={};
    query.select=()=>query;query.eq=()=>query;
    query.maybeSingle=vi.fn(async()=>({data:current,error:null}));
    query.upsert=upsert;
    const db={from:vi.fn(()=>query)} as unknown as SupabaseClient;
    await recordBriefRun(db,{...record,reason:"already_sent"},now,{preserveExisting:true});
    expect(upsert).not.toHaveBeenCalled();
    expect(current.reason).toBe("posted");
  });
  it("repairs a failed in-app run record after the persisted message is recovered",async()=>{
    let current:Record<string,unknown>={outcome:"failed",reason:"brief_write_failed"};
    const upsert=vi.fn(async(next:Record<string,unknown>)=>{current=next;return {error:null};});
    const query:Record<string,unknown>={};
    query.select=()=>query;query.eq=()=>query;
    query.maybeSingle=vi.fn(async()=>({data:current,error:null}));
    query.upsert=upsert;
    const db={from:vi.fn(()=>query)} as unknown as SupabaseClient;
    await recordBriefRun(db,{...record,reason:"already_sent"},now,{preserveExisting:true});
    expect(current).toMatchObject({outcome:"sent",reason:"already_sent"});
  });
  it("preserves a durable WhatsApp provider failure when the in-app message is already present",async()=>{
    const current:Record<string,unknown>={outcome:"failed",reason:"provider_rejected:http400"};
    const upsert=vi.fn(async()=>({error:null}));
    const query:Record<string,unknown>={};
    query.select=()=>query;query.eq=()=>query;
    query.maybeSingle=vi.fn(async()=>({data:current,error:null}));
    query.upsert=upsert;
    const db={from:vi.fn(()=>query)} as unknown as SupabaseClient;
    await recordBriefRun(db,{...record,channel:"whatsapp",outcome:"skipped",reason:"already_handled"},
      now,{preserveExisting:true});
    expect(upsert).not.toHaveBeenCalled();
    expect(current.reason).toBe("provider_rejected:http400");
  });
});
