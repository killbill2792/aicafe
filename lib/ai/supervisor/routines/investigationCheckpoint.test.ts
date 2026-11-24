import {afterEach,describe,expect,it,vi} from "vitest";
import {z} from "zod";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {AgentToolResult} from "@/lib/ai/agent/tools";
import {investigationResearchCheckpoint,investigationResearchIdentity} from "./investigationCheckpoint.server";
vi.mock("server-only",()=>({}));
afterEach(()=>vi.unstubAllEnvs());
const c={business_id:"business-a",owner_user_id:"owner-a",thread_id:"thread-a",source_type:"alert",
 source_id:"alert-a",episode_id:"aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",revision_hash:"a".repeat(64),step_version:1,lease_token:"lease-a"};
const fact:AgentToolResult={source:"u3_canonical_research",period:null,missing:[],rows:[{amount:125}],truncated:false,evidence:{receipt_id:"receipt-a"},page_retrieval:"executed_query"};
describe("investigation encrypted research continuation",()=>{
 it("binds the exact episode, evidence revision, step and linked answer while surviving lease replacement",()=>{
  const identity=investigationResearchIdentity(c,null);
  expect(z.uuid().safeParse(identity).success).toBe(true);
  expect(investigationResearchIdentity({...c,lease_token:"lease-b"},null)).toBe(identity);
  expect(investigationResearchIdentity({...c,step_version:2},null)).not.toBe(identity);
  expect(investigationResearchIdentity({...c,revision_hash:"b".repeat(64)},null)).not.toBe(identity);
  expect(investigationResearchIdentity(c,"reply-a")).not.toBe(identity);
 });
 it("restores encrypted research after a worker replacement and avoids treating a cache replay or refusal as new progress",async()=>{
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY","synthetic-private-service-key-at-least-24-chars");
  const stored:Array<Record<string,unknown>>=[];
  const rpc=vi.fn(async(_name:string,args:Record<string,unknown>)=>{
   if(args.p_action==="store")stored.push({operation:args.p_operation,checkpoint_seq:stored.length+1,ciphertext:args.p_ciphertext,key:args.p_progress_key});
   return {data:args.p_action==="load"?stored.filter(row=>Number(row.checkpoint_seq)>Number(args.p_after_seq)):true,error:null};
  });
  const db={rpc} as unknown as SupabaseClient;
  const first=investigationResearchCheckpoint(db,c,null);
  await first.beginTool("query_data",{sql:"SELECT private_amount"},true);
  await first.endTool(fact);
  await first.beginTool("query_data",{sql:"SELECT private_amount"},true);
  await first.endTool({...fact,evidence:{receipt_id:"receipt-b"},page_retrieval:"retained_result"});
  await first.beginTool("calculate",{},true);
  await first.endTool({source:"calculate",period:null,missing:[],refused:"invalidInput"});
  expect(stored).toHaveLength(2);
  expect(stored[0].key).toBe(stored[1].key);
  expect(stored[0].ciphertext).not.toContain("private_amount");
  expect(await first.yieldForRetry(60,"technical")).toBe(true);
  const resumed=investigationResearchCheckpoint(db,{...c,lease_token:"lease-b"},null);
  expect(await resumed.resumeContext()).toContain("RESUMED ORIGINAL INVESTIGATION");
  expect(resumed.researchReads?.()[0].result).toEqual(fact);
  expect(resumed.researchReads?.()[0].arguments).toBe(JSON.stringify({sql:"SELECT private_amount"}));
  expect(rpc.mock.calls.at(-1)?.[1].p_lease_token).toBe("lease-b");
  await resumed.beginTool("propose_staff_question",{},false);
  await resumed.endTool({source:"staff_question",period:null,missing:[]});
  expect(resumed.canYield()).toBe(false);
  expect(await resumed.yieldForRetry(60,"technical")).toBe(false);
 });
});
