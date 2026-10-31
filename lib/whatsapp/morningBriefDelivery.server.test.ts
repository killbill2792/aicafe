import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>({
 active:vi.fn(),allowed:vi.fn(),prepare:vi.fn(),enqueue:vi.fn(),
}));
vi.mock("./identity.server",()=>({activeBinding:mocks.active}));
vi.mock("./transport.server",()=>({providerAllowed:mocks.allowed}));
vi.mock("./queue.server",()=>({enqueueWhatsApp:mocks.enqueue}));
vi.mock("./morningBrief.server",()=>({readPreparedMorningBrief:mocks.prepare}));
import {eligibleBriefBinding,prepareBoundBrief,enqueueBoundBrief} from "./morningBriefDelivery.server";
import {renderMorningBrief} from "./morningBrief";

const now=new Date("2026-10-31T12:50:00Z"); // 05:50 PDT
const binding={id:"123e4567-e89b-42d3-a456-426614174000",businessId:"cafe-a",
 ownerUserId:"owner-a",threadId:"thread-a",waId:"15556506570",
 phoneNumberId:"1322195347653883",lastOwnerMessageAt:"2026-10-31T05:00:00Z"};
const scope={businessId:"cafe-a",ownerUserId:"owner-a",threadId:"thread-a",
 businessName:"Shop A",currency:"EUR",timezone:"America/Los_Angeles",
 today:"2026-10-31",yesterday:"2026-10-30"};
const prepared={
 netSalesCents:139262,
 parameters:["Shop A","€1,392.62","158","Latte","50","Festival at 15:00","Saturday"] as const,
 businessDate:"2026-10-30",today:"2026-10-31",
 provenance:{sales:"daily_rollups",items:"menu_item_quantities_sold",menu:"menu_items",
   eventId:"event-1",monitorProposalId:"monitor-1"} as const,
};
function dbFactory(rows:Array<{id:string}>=[{id:binding.id}]){
 const calls:Array<{method:string;key?:string;value?:unknown}>=[];
 const query:Record<string,unknown>={};
 for(const method of ["select","eq","is"])query[method]=(key:string,value:unknown)=>{
   calls.push({method,key,value});return query;
 };
 query.limit=async()=>({data:rows,error:null});
 return {db:{from:vi.fn(()=>query)} as unknown as SupabaseClient,calls};
}
const envNames=["WHATSAPP_OWNER_REPLY_SEND_ENABLED","WHATSAPP_MONITOR_FOLLOWUP_APPROVED"] as const;
const originals=Object.fromEntries(envNames.map(x=>[x,process.env[x]]));
beforeEach(()=>{
 mocks.active.mockReset().mockResolvedValue(binding);
 mocks.allowed.mockReset().mockReturnValue(true);
 mocks.prepare.mockReset().mockResolvedValue(prepared);
 mocks.enqueue.mockReset().mockResolvedValue(binding.id);
 for(const name of envNames)process.env[name]="true";
});
afterEach(()=>{for(const name of envNames){
 if(originals[name]===undefined)delete process.env[name];else process.env[name]=originals[name];
}});
describe("PR A verified morning-brief integration",()=>{
 it("selects exactly one binding only for matching owner and café",async()=>{
   const {db,calls}=dbFactory();
   expect(await eligibleBriefBinding(db,scope)).toEqual(binding);
   expect(calls).toContainEqual({method:"eq",key:"business_id",value:"cafe-a"});
   expect(calls).toContainEqual({method:"eq",key:"owner_user_id",value:"owner-a"});
   expect(await eligibleBriefBinding(dbFactory([]).db,scope)).toBeNull();
   expect(await eligibleBriefBinding(dbFactory([{id:binding.id},{id:"other"}]).db,scope)).toBeNull();
   mocks.active.mockResolvedValueOnce({...binding,businessId:"cafe-b"});
   expect(await eligibleBriefBinding(db,scope)).toBeNull();
 });
 it("keeps default-off and missing follow-up permission out of the data reader",async()=>{
   const {db}=dbFactory();
   mocks.allowed.mockReturnValueOnce(false);
   expect(await eligibleBriefBinding(db,scope)).toBeNull();
   delete process.env.WHATSAPP_MONITOR_FOLLOWUP_APPROVED;
   expect(await eligibleBriefBinding(db,scope)).toBeNull();
   expect(mocks.prepare).not.toHaveBeenCalled();
 });
 it("reconciles website text with the exact seven WhatsApp values",async()=>{
   const {db}=dbFactory();
   const result=await prepareBoundBrief(db,scope,now,binding);
   expect(result?.websiteText).toBe(renderMorningBrief(prepared.parameters));
   expect(result?.websiteText).toContain("€1,392.62");
   expect(result?.websiteText).toContain("158");
   expect(mocks.prepare).toHaveBeenCalledWith(db,
     {...scope,verifiedBinding:true,followupPermitted:true},now);
 });
 it("does not promise late, future-timestamped or expired monitoring follow-up",async()=>{
   const {db}=dbFactory();
   for(const lastOwnerMessageAt of [null,"2026-10-29T05:00:00Z","2026-11-02T00:00:00Z",
       "2026-10-30T01:00:00Z"]){
     expect(await prepareBoundBrief(db,scope,now,{...binding,lastOwnerMessageAt})).toBeNull();
   }
   expect(await prepareBoundBrief(db,{...scope,threadId:"other"},now,binding)).toBeNull();
   expect(await prepareBoundBrief(db,scope,new Date("2026-10-31T13:00:00Z"),binding)).toBeNull();
   expect(await prepareBoundBrief(db,scope,new Date("2026-10-31T12:10:00Z"),binding)).toBeNull();
   expect(mocks.prepare).not.toHaveBeenCalled();
 });
 it("enqueues against PR A's unique owner/café/day key and saved website message",async()=>{
   const {db}=dbFactory();
   const item=(await prepareBoundBrief(db,scope,now,binding))!;
   const sourceId="123e4567-e89b-42d3-a456-426614174001";
   await enqueueBoundBrief(item,scope,sourceId,now);
   expect(mocks.enqueue).toHaveBeenCalledWith(binding.id,
     "daily-brief:cafe-a:owner-a:2026-10-31",
     {kind:"daily_brief",fields:prepared.parameters},
     expect.objectContaining({source:"canonical_daily_brief",period:"2026-10-30",
       eventId:"event-1",monitorId:"monitor-1"}),
     sourceId,undefined,"2026-10-31");
   mocks.active.mockResolvedValueOnce(null);
   await enqueueBoundBrief(item,scope,sourceId,now);
   expect(mocks.enqueue).toHaveBeenCalledTimes(1);
 });
});
