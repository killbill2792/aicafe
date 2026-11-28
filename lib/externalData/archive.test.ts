import type {SupabaseClient} from "@supabase/supabase-js";
import {describe,expect,it,vi} from "vitest";
import {SourceRetryDeferred,synchronizeSource} from "./archive.server";

vi.mock("server-only",()=>({}));

const source={businessId:"café",provider:"public-library",account:"catalogue"};
const capability={resource:"local finding aids",permission:"read public catalogue",granted:true};
const first={key:"accession-7",payload:{"Shelf notes":[null,{"décor / condition":"intact"}]}};
const second={key:"accession-8",payload:{"Additional leaf":[{"minutes":32},false]}};

function database(retryAt?:string,legacyCursor?:string) {
  let revision=0;
  let cursor_state: unknown = legacyCursor??null;
  let members: Array<{record_id:string;payload:unknown}> = [];
  const checkpoint={select:()=>checkpoint,eq:()=>checkpoint,maybeSingle:async()=>({data:{revision,cursor_state,retry_at:retryAt}})};
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
    if(name==="external_commit_page"){
      expect(args.p_revision).toBe(revision);
      if(!cursor_state || (cursor_state as {cursor?:unknown}).cursor===null)members=[];
      const records=args.p_records as Array<{key:string;payload:unknown}>;
      members.push(...records.map(row=>({record_id:row.key,payload:row.payload})));
      cursor_state=args.p_next;
      return {data:++revision,error:null};
    }
    if(name==="external_read_observation")return {data:members,error:null};
    return {data:null,error:null};
  });
  return {db:{from:()=>checkpoint,rpc} as unknown as SupabaseClient,rpc};
}

const defaults={capability,stream:"latest",authorize:async()=>{},readCompleted:true,
  failure:()=>({status:"unavailable" as const,retryAt:"2026-11-27T10:00:00Z"})};

describe("shared external observation",()=>{
  it("restarts unscoped legacy cursors without querying the wrong window",async()=>{
    const {db,rpc}=database(undefined,"unscoped provider token");
    const observe=vi.fn().mockResolvedValueOnce({records:[first],next:null});
    await synchronizeSource(db,source,{...defaults,observe,scope:{edition:"new"}});
    expect(observe.mock.calls).toEqual([[null,{edition:"new"}]]);
    expect(rpc).toHaveBeenCalledWith("external_commit_page",expect.objectContaining({
      p_next:null,p_complete:false,p_records:[],
    }));
  });
  it("resumes non-POS data in its original query scope before observing a new scope",async()=>{
    const {db,rpc}=database();
    const interrupted=vi.fn().mockResolvedValueOnce({records:[first],next:"opaque token"})
      .mockRejectedValueOnce(new Error("temporary provider failure"));
    await expect(synchronizeSource(db,source,{...defaults,scope:{edition:"first"},observe:interrupted}))
      .rejects.toThrow("temporary provider failure");
    expect(rpc).toHaveBeenCalledWith("external_note_availability",expect.objectContaining({p_status:"unavailable"}));
    const observe=vi.fn().mockResolvedValueOnce({records:[second],next:null})
      .mockResolvedValueOnce({records:[first,second],next:null});
    const result=await synchronizeSource(db,source,{...defaults,scope:{edition:"revised"},observe});
    expect(observe.mock.calls).toEqual([["opaque token",{edition:"first"}],[null,{edition:"revised"}]]);
    expect(result).toEqual([first.payload,second.payload]);
    expect(rpc.mock.calls.filter(([name])=>name==="external_commit_page").map(([,p])=>p.p_next)).toEqual([
      {cursor:"opaque token",scope:{edition:"first"},mode:"snapshot"},
      {cursor:null,scope:{edition:"first"},mode:"snapshot"},
      {cursor:null,scope:{edition:"revised"},mode:"snapshot"},
    ]);
    expect(rpc).toHaveBeenCalledWith("external_read_observation",expect.objectContaining({
      p_scope:{edition:"revised"},p_mode:"snapshot",
    }));
  });

  it("discards a page when the source grant changes while fetching",async()=>{
    const {db,rpc}=database();
    const authorize=vi.fn().mockResolvedValueOnce("before").mockResolvedValueOnce("after");
    await expect(synchronizeSource(db,source,{...defaults,scope:{},authorize,
      observe:async()=>({records:[first],next:null})}))
      .rejects.toThrow("External source access changed");
    expect(rpc.mock.calls.map(([name])=>name)).toEqual(["external_discover_resources","external_note_availability"]);
    expect(rpc).toHaveBeenCalledWith("external_note_availability",expect.objectContaining({p_status:"permission_required"}));
  });

  it("honors a persisted provider retry deadline before fetching any page",async()=>{
    const {db}=database(new Date(Date.now()+60_000).toISOString());
    const observe=vi.fn();
    await expect(synchronizeSource(db,source,{...defaults,scope:{},observe})).rejects.toBeInstanceOf(SourceRetryDeferred);
    expect(observe).not.toHaveBeenCalled();
  });

  it("recovers a Clover offset page and preserves expanded merchant objects without schema mappings",async()=>{
    const {db,rpc}=database();
    const merchant={businessId:source.businessId,provider:"clover",account:"test-merchant"};
    const window={modifiedFrom:"1795752000000",modifiedThrough:"1795755600000"};
    const order={
      id:"4JXF1VGWBQCK2",modifiedTime:1795752300000,total:0,
      lineItems:{elements:[{id:"5C4EPMGXZY19J",item:{id:"VNGW94K2WF2FJ"},price:0}]},
      discounts:{elements:[{id:"9AAB5JF8ME8JE",amount:null}]},
    };
    const nextOrder={id:"WRCVPKN251J93",modifiedTime:1795752600000,total:500};
    // Clover v3 returns an elements envelope. The connector owns conversion
    // from its offset to an opaque token and keeps the expanded source object.
    const observe=vi.fn().mockImplementationOnce(async (cursor,scope)=>{
      expect(cursor).toBeNull();
      expect(scope).toEqual(window);
      return {records:[{key:order.id,payload:order,updatedAt:new Date(order.modifiedTime).toISOString()}],next:"1"};
    }).mockRejectedValueOnce(new Error("Clover temporarily unavailable"))
      .mockImplementationOnce(async (cursor,scope)=>{
        expect(cursor).toBe("1");
        expect(scope).toEqual(window);
        return {records:[{key:nextOrder.id,payload:nextOrder,updatedAt:new Date(nextOrder.modifiedTime).toISOString()}],next:null};
      });
    const plan={...defaults,capability:{resource:"orders",permission:"Read orders",granted:true},
      stream:"orders-modified",mode:"incremental" as const,scope:window,observe};
    await expect(synchronizeSource(db,merchant,plan)).rejects.toThrow("Clover temporarily unavailable");
    await expect(synchronizeSource(db,merchant,plan)).resolves.toEqual([order,nextOrder]);
    expect(rpc).toHaveBeenCalledWith("external_read_observation",expect.objectContaining({
      p_provider:"clover",p_account:merchant.account,p_scope:window,p_mode:"incremental",
    }));
  });
});
