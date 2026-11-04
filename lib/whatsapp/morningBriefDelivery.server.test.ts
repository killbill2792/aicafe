import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({active:vi.fn(),blockers:vi.fn(),enqueue:vi.fn(),dispatch:vi.fn()}));
vi.mock("./identity.server",()=>({activeBinding:mocks.active}));
vi.mock("./transport.server",()=>({providerBlockers:mocks.blockers,
  providerAllowed:(kind:string)=>mocks.blockers(kind).length===0}));
vi.mock("./queue.server",()=>({enqueueWhatsApp:mocks.enqueue,dispatchOutboundOnce:mocks.dispatch}));
import {eligibleBriefBinding,prepareBoundBrief,enqueueBoundBrief,dispatchDueMorningBriefs,
  BRIEF_SEND_MIGRATION} from "./morningBriefDelivery.server";
import {buildBriefContent,renderMorningBrief} from "./morningBrief";

const now=new Date("2026-11-03T13:50:00Z"); // 05:50 PST
const binding={id:"123e4567-e89b-42d3-a456-426614174000",businessId:"cafe-a",
 ownerUserId:"owner-a",threadId:"thread-a",waId:"15556506570",
 phoneNumberId:"1322195347653883",lastOwnerMessageAt:null as string|null};
const scope={businessId:"cafe-a",ownerUserId:"owner-a",threadId:"thread-a",
 businessName:"Shop A",currency:"USD",timezone:"America/Los_Angeles",
 today:"2026-11-03",yesterday:"2026-11-02"};
const content=buildBriefContent({businessName:"Shop A",currency:"USD",today:"2026-11-03",
  yesterday:"2026-11-02",netSalesCents:139262,
  sold:{available:true,linked:[{id:"latte",units:50}],unlinked:[]},
  menu:[{id:"latte",name:"Latte",base_name:null,category:"Espresso"}],categoryLabels:new Map(),
  events:{available:true,items:[],coverage:"complete"}},now);
const sendBefore="2026-11-03T14:30:00.000Z";
function bindingsDb(rows:Array<{id:string}>|null,ready=true){
  const calls:Array<{key:string;value:unknown}>=[];
  const query:Record<string,unknown>={};
  for(const method of ["select","eq","is"])query[method]=(key:string,value:unknown)=>{
    calls.push({key,value});return query;};
  query.limit=async()=>rows===null?{data:null,error:{message:"down"}}:{data:rows,error:null};
  return {db:{from:vi.fn(()=>query),rpc:vi.fn(async()=>ready?{data:true,error:null}:
    {data:null,error:{message:"missing"}})} as unknown as SupabaseClient,calls};
}
const savedEnv=process.env.WHATSAPP_BRIEF_TEMPLATE_SET;
beforeEach(()=>{
  mocks.active.mockReset().mockResolvedValue(binding);
  mocks.blockers.mockReset().mockReturnValue([]);
  mocks.enqueue.mockReset().mockResolvedValue(binding.id);
  mocks.dispatch.mockReset().mockResolvedValue("empty");
  delete process.env.WHATSAPP_BRIEF_TEMPLATE_SET;
});
afterEach(()=>{if(savedEnv===undefined)delete process.env.WHATSAPP_BRIEF_TEMPLATE_SET;
  else process.env.WHATSAPP_BRIEF_TEMPLATE_SET=savedEnv;});

describe("verified WhatsApp recipient for the template brief",()=>{
  it("selects exactly one verified binding for this owner and café, else says why",async()=>{
    const {db,calls}=bindingsDb([{id:binding.id}]);
    expect(await eligibleBriefBinding(db,scope)).toEqual({binding});
    expect(calls).toContainEqual({key:"business_id",value:"cafe-a"});
    expect(calls).toContainEqual({key:"owner_user_id",value:"owner-a"});
    expect(calls).toContainEqual({key:"opted_in",value:true});
    expect(await eligibleBriefBinding(bindingsDb([]).db,scope)).toEqual({reason:"no_linked_whatsapp_number"});
    expect(await eligibleBriefBinding(bindingsDb([{id:"a"},{id:"b"}]).db,scope))
      .toEqual({reason:"more_than_one_whatsapp_binding"});
    expect(await eligibleBriefBinding(bindingsDb(null).db,scope)).toEqual({reason:"whatsapp_binding_read_failed"});
    mocks.active.mockResolvedValueOnce(null);
    expect(await eligibleBriefBinding(db,scope)).toEqual({reason:"whatsapp_binding_not_verified"});
    mocks.active.mockResolvedValueOnce({...binding,businessId:"cafe-b"});
    expect(await eligibleBriefBinding(db,scope)).toEqual({reason:"whatsapp_binding_other_cafe"});
  });
  it("names every send setting that is off, before reading any binding",async()=>{
    mocks.blockers.mockReturnValue(["WHATSAPP_TEMPLATE_APPROVED","META_WHATSAPP_TOKEN"]);
    const {db}=bindingsDb([{id:binding.id}]);
    expect(await eligibleBriefBinding(db,scope)).toEqual({reason:"whatsapp_setting_off",
      details:{settings:["WHATSAPP_TEMPLATE_APPROVED","META_WHATSAPP_TOKEN"]}});
    expect(db.from).not.toHaveBeenCalled();
  });
  it("never asks for an owner message in the last 24 hours: a template can go out any time",async()=>{
    for(const lastOwnerMessageAt of [null,"2020-01-01T00:00:00Z","2026-11-01T00:00:00Z"]){
      const r=prepareBoundBrief(content,{...binding,lastOwnerMessageAt},"thread-a");
      expect("brief" in r&&r.brief.prepared.fields).toEqual(["Shop A","$1,392.62",
        "50 items in total (drink split not ready yet)","Latte","50","No major events near you this week.",
        "Tuesday (automatic sales alerts are not on yet)"]);
    }
    expect(prepareBoundBrief(content,binding,"other-thread")).toEqual({reason:"whatsapp_binding_thread_mismatch"});
  });
  it("website copy is the exact same template text as the WhatsApp blanks",()=>{
    const r=prepareBoundBrief(content,binding,"thread-a");
    if(!("brief" in r))throw new Error("expected brief");
    expect(r.brief.websiteText).toBe(renderMorningBrief(r.brief.prepared));
    expect(r.brief.websiteText).toContain("Net sales: $1,392.62");
    process.env.WHATSAPP_BRIEF_TEMPLATE_SET="split";
    const split=prepareBoundBrief(content,binding,"thread-a");
    expect("brief" in split&&split.brief.prepared.template.name).toBe("cafe_profit_brief_no_event");
  });
});

describe("queue and send",()=>{
  const brief=()=>{const r=prepareBoundBrief(content,binding,"thread-a");
    if(!("brief" in r))throw new Error("expected brief");return r.brief;};
  it("queues once per owner, café and local day, with the café's own deadline and template",async()=>{
    const {db}=bindingsDb([{id:binding.id}]);
    const source="123e4567-e89b-42d3-a456-426614174001";
    expect(await enqueueBoundBrief(db,brief(),scope,source,sendBefore,now)).toEqual({outcome:"queued"});
    expect(mocks.enqueue).toHaveBeenCalledWith(binding.id,"daily-brief:cafe-a:owner-a:2026-11-03",
      {kind:"daily_brief",template:"cafe_profit_daily_brief",fields:brief().prepared.fields},
      expect.objectContaining({source:"canonical_daily_brief",period:"2026-11-02"}),
      source,undefined,"2026-11-03",sendBefore);
  });
  it("says why it did not queue: setting off, deadline passed, migration missing, binding gone, queue down",async()=>{
    const {db}=bindingsDb([{id:binding.id}]);
    const source="123e4567-e89b-42d3-a456-426614174001";
    mocks.blockers.mockReturnValueOnce(["WHATSAPP_OWNER_BRIEF_SEND_ENABLED"]);
    expect(await enqueueBoundBrief(db,brief(),scope,source,sendBefore,now)).toEqual({outcome:"skipped",
      reason:"whatsapp_setting_off",details:{settings:["WHATSAPP_OWNER_BRIEF_SEND_ENABLED"]}});
    expect(await enqueueBoundBrief(db,brief(),scope,source,"2026-11-03T13:00:00Z",now))
      .toMatchObject({outcome:"skipped",reason:"past_send_deadline"});
    expect(await enqueueBoundBrief(bindingsDb([],false).db,brief(),scope,source,sendBefore,now))
      .toEqual({outcome:"skipped",reason:"migration_missing",details:{migration:BRIEF_SEND_MIGRATION}});
    mocks.active.mockResolvedValueOnce(null);
    expect(await enqueueBoundBrief(db,brief(),scope,source,sendBefore,now))
      .toEqual({outcome:"skipped",reason:"whatsapp_binding_not_verified"});
    mocks.enqueue.mockRejectedValueOnce(new Error("queue_unavailable"));
    expect(await enqueueBoundBrief(db,brief(),scope,source,sendBefore,now))
      .toEqual({outcome:"failed",reason:"whatsapp_queue_unavailable"});
  });
  it("does not dispatch until migration 148 is applied, and says so",async()=>{
    const {db}=bindingsDb([],false);
    expect(await dispatchDueMorningBriefs(db)).toEqual({accepted:0,reason:"migration_missing",
      details:{migration:BRIEF_SEND_MIGRATION}});
    expect(mocks.dispatch).not.toHaveBeenCalled();
    mocks.blockers.mockReturnValueOnce(["WHATSAPP_POLICY_APPROVED"]);
    expect(await dispatchDueMorningBriefs(bindingsDb([]).db)).toMatchObject({accepted:0,reason:"whatsapp_setting_off"});
  });
  it("at send time, checks the leased brief's own deadline and local day, not a fixed 05:50-06:00",async()=>{
    let lease={business_date:"2026-11-03",send_before:sendBefore as string|null};
    const db={rpc:vi.fn(async()=>({data:true,error:null})),
      from:vi.fn((table:string)=>{
        const query:Record<string,unknown>={};
        for(const method of ["select","eq","is"])query[method]=()=>query;
        query.limit=async()=>({data:table==="whatsapp_owner_bindings"?[{id:binding.id}]:[lease],error:null});
        query.maybeSingle=async()=>({data:{timezone:"America/Los_Angeles"},error:null});
        return query;
      })} as unknown as SupabaseClient;
    const send=vi.fn(async()=>new Response("{}",{status:200}));
    mocks.dispatch.mockImplementation(async(_kind:string,guardedSend:typeof fetch)=>{
      const response=await guardedSend("https://graph.facebook.com/test",{
        method:"POST",body:JSON.stringify({to:binding.waId,type:"template"})});
      return response.ok?"accepted":"failed";
    });
    // 06:20 local: long past the old 06:00 cut-off, still before this café's 06:30 opening.
    expect(await dispatchDueMorningBriefs(db,send as typeof fetch,()=>new Date("2026-11-03T14:20:00Z")))
      .toEqual({accepted:10});
    send.mockClear();
    expect((await dispatchDueMorningBriefs(db,send as typeof fetch,()=>new Date("2026-11-03T14:30:00Z"))).accepted).toBe(0);
    lease={business_date:"2026-11-02",send_before:sendBefore};
    expect((await dispatchDueMorningBriefs(db,send as typeof fetch,()=>new Date("2026-11-03T14:00:00Z"))).accepted).toBe(0);
    lease={business_date:"2026-11-03",send_before:null};
    expect((await dispatchDueMorningBriefs(db,send as typeof fetch,()=>new Date("2026-11-03T13:55:00Z"))).accepted).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
