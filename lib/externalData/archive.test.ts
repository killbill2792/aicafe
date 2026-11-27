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
      {cursor:"opaque token",scope:{edition:"first"}},
      {cursor:null,scope:{edition:"first"}},
      {cursor:null,scope:{edition:"revised"}},
    ]);
  });

  it("discards a page when the source grant changes while fetching",async()=>{
    const {db,rpc}=database();
    const authorize=vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("grant changed"));
    await expect(synchronizeSource(db,source,{...defaults,scope:{},authorize,
      observe:async()=>({records:[first],next:null}),failure:()=>({status:"permission_required"})}))
      .rejects.toThrow("grant changed");
    expect(rpc.mock.calls.map(([name])=>name)).toEqual(["external_discover_resources","external_note_availability"]);
  });

  it("honors a persisted provider retry deadline before fetching any page",async()=>{
    const {db}=database(new Date(Date.now()+60_000).toISOString());
    const observe=vi.fn();
    await expect(synchronizeSource(db,source,{...defaults,scope:{},observe})).rejects.toBeInstanceOf(SourceRetryDeferred);
    expect(observe).not.toHaveBeenCalled();
  });
});
