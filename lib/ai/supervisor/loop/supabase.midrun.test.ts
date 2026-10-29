import {describe,expect,it,vi,beforeEach} from "vitest";
const writes=vi.hoisted(()=>({rows:[] as Array<{table:string;op:string;row:Record<string,unknown>}>}));
vi.mock("@/lib/supabase/admin",()=>({createAdminSupabaseClient:()=>({from:(table:string)=>{
  const q:Record<string,unknown>={};
  for(const m of ["select","eq"])q[m]=()=>q;
  q.single=async()=>({data:{timezone:"America/Los_Angeles"},error:null});
  q.upsert=async(row:Record<string,unknown>)=>{writes.rows.push({table,op:"upsert",row});return {error:null};};
  q.insert=async(row:Record<string,unknown>)=>{writes.rows.push({table,op:"insert",row});return {error:null};};
  return q;
}})}));
import {SupabaseLoopRepository,stableMessageId} from "./supabase.server";
import type {LoopProposal,LoopReport} from "./engine";

const scope={businessId:"b0000000-0000-4000-8000-000000000001",ownerUserId:"u0000000-0000-4000-8000-000000000001",
  threadId:"t0000000-0000-4000-8000-000000000001",locale:"en" as const};
const p={id:"p0000000-0000-4000-8000-000000000001",capabilityId:"alex.drink_price_experiment.v1",threadId:scope.threadId} as LoopProposal;
const report:LoopReport={status:"in_progress",result:{},recommendation:"adjust",source:"order_lines",
  midRunText:"Halfway update on Latte",
  delivery:{agentId:"alex",taskKind:"price_experiment_report",entityType:"menu_item",entityId:"x",
    payload:{itemName:"Latte",outcomeStatus:"in_progress"},confidence:"low",evidence:[],threadText:"final"}};

describe("mid-run update delivery",()=>{
  beforeEach(()=>{writes.rows.length=0;});
  it("posts one chat message and one watching inbox item with its own id",async()=>{
    await new SupabaseLoopRepository().saveReport(scope,p,report,{midRun:true});
    const task=writes.rows.find(w=>w.table==="operating_tasks")!;
    expect(task.row).toMatchObject({id:"supervisor:alex.drink_price_experiment.v1:"+p.id+":midrun",
      status:"watching",payload:{midRun:true,outcomeStatus:"in_progress",proposalId:p.id,threadId:p.threadId}});
    const message=writes.rows.find(w=>w.table==="ai_messages")!;
    expect(message.row).toMatchObject({id:stableMessageId("supervisor-midrun:"+p.id),thread_id:scope.threadId,
      role:"supervisor",structured_content:[{type:"text",text:"Halfway update on Latte"}]});
  });
  it("sends nothing for an ordinary in-progress save",async()=>{
    await new SupabaseLoopRepository().saveReport(scope,p,report);
    expect(writes.rows.map(w=>w.table)).toEqual(["supervisor_reports"]);
  });
});
