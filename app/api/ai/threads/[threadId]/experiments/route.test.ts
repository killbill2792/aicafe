import {beforeEach,describe,expect,it,vi} from "vitest";
const f=vi.hoisted(()=>({businessId:"11111111-1111-4111-8111-111111111111",
 ownerUserId:"22222222-2222-4222-8222-222222222222",threadId:"33333333-3333-4333-8333-333333333333",
 proposalId:"44444444-4444-4444-8444-444444444444",approved:0,committed:0,access:0}));
vi.mock("@/lib/ai/conversations/auth.server",()=>({
 authenticatedConversationContext:async()=>({scope:{businessId:f.businessId,ownerUserId:f.ownerUserId},
  service:{getThread:async(id:string)=>{if(id!==f.threadId)throw Error("thread_not_found");return {id};}}}),
}));
vi.mock("@/lib/access/access.server",()=>({assertCafeAiAccess:async()=>{f.access++;}}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({from:()=>({select:()=>({eq:()=>({eq:()=>({maybeSingle:async()=>({data:null,error:null})})})})})})}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:async()=>[]}));
vi.mock("@/lib/ai/supervisor/loop/priceExperiment.server",()=>({
 priceExperimentCapabilityId:"alex.drink_price_experiment.v1",supervisorLoopRegistry:{},
}));
vi.mock("@/lib/ai/supervisor/loop/reads.server",()=>({readOwnerProposals:async()=>[]}));
vi.mock("@/lib/ai/supervisor/loop/supabase.server",()=>({SupabaseLoopRepository:class{}}));
vi.mock("@/lib/ai/supervisor/loop/engine",()=>({
 simulateLoop:vi.fn(),proposeLoop:vi.fn(),approveLoop:vi.fn(async()=>{f.approved++;return {id:f.proposalId,revision:2};}),
 commitLoop:vi.fn(async()=>{f.committed++;return {proposal:{id:f.proposalId,status:"committed"}};}),
 confirmManualLoop:vi.fn(),monitorLoop:vi.fn(),utcDateOffset:(d:string)=>d,
}));
import {POST} from "./route";
import {approveLoop,commitLoop} from "@/lib/ai/supervisor/loop/engine";
const url="http://localhost:3000/api/ai/threads/"+f.threadId+"/experiments";
const params={params:Promise.resolve({threadId:f.threadId})};
function post(body:Record<string,unknown>){
 return POST(new Request(url,{method:"POST",headers:{origin:"http://localhost:3000","content-type":"application/json"},
  body:JSON.stringify(body)}),params);
}
beforeEach(()=>{f.approved=0;f.committed=0;f.access=0;vi.clearAllMocks();});
describe("experiment effects use the individual-click gateway path",()=>{
 it("records approval separately and does not execute on the approval request",async()=>{
  const response=await post({action:"approve",proposalId:f.proposalId,revision:1});
  expect(response.status).toBe(200);
  expect(vi.mocked(approveLoop)).toHaveBeenCalled();
  expect(f.committed).toBe(0);
 });
 it("routes the effect commit through commitLoop with the authenticated owner scope",async()=>{
  const response=await post({action:"commit",proposalId:f.proposalId,revision:2});
  expect(response.status).toBe(200);
  expect(vi.mocked(commitLoop)).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.anything(),f.proposalId,2,"click");
  expect(f.committed).toBe(1);
  expect(f.access).toBe(1);
 });
});
