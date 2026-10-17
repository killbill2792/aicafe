/** Compatibility-only regression suite. Default conversational runtime acceptance
 * is in lib/ai/supervisor/investigation/runInvestigation.server.test.ts. */
import {beforeAll,afterAll,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {runLegacySupervisorTurn as runSupervisorTurn} from "./runSupervisorTurn.server";
import {createSupervisorDiagnosticLogger,type SupervisorDiagnostic} from "./diagnostics.server";
import type {RequestedGoal} from "./requestScope";
import type {BusinessScopedCafeTools} from "@/lib/ai/tools";
import {buildSupervisorInstructions,buildSupervisorScopeAuditRequest,
  SUPERVISOR_SCOPE_TAXONOMY} from "./supervisorRequest.mjs";

let savedKey:string|undefined;
beforeAll(()=>{savedKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY="fixture-not-real";});
afterAll(()=>{if(savedKey===undefined)delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY=savedKey;});
const quality={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const requested=(domain:RequestedGoal["domain"]="team",period:RequestedGoal["period"]="today"):RequestedGoal=>({
  domain,period,from:null,to:null,comparison_period:null,comparison_from:null,comparison_to:null,
});
const call=(name:string,args:unknown,id:string)=>({type:"function_call",name,
  arguments:JSON.stringify(args),call_id:id});
const modelResponse=(output:unknown[])=>new Response(JSON.stringify({
  model:"gpt-6-luna",status:"completed",usage:{input_tokens:20,output_tokens:10},output,
}),{status:200,headers:{"content-type":"application/json"}});
const auditResponse=(goals:RequestedGoal[],complete=true,ambiguous=false)=>modelResponse([{
  type:"message",content:[{type:"output_text",text:JSON.stringify({goals,complete,ambiguous})}],
}]);
const finalResponse=()=>modelResponse([{type:"message",content:[{type:"output_text",
  text:JSON.stringify({headline:"Here is the recorded picture",
    summary:"Based on the available café records",fact_ids:[],task_ids:[],insight_ids:[],evidence_refs:[]}),
}]}]);
const persisted=(status:"needs_owner"|"needs_response",id:string)=>({
  id,agentId:"alex" as const,businessId:"authorized-fixture-business",
  kind:"price_review" as const,status,payload:{itemName:"Latte"},
  confidence:"high" as const,evidence:[],createdAt:"2026-10-12T10:00:00Z",
});
const phrases=[
  "What task needs my attention?",
  "What tasks need my attention?",
  "What do I need to handle?",
  "Is anything waiting for me?",
  "What does the AI Team need from me?",
  "Show me anything that needs my approval.",
  "Do I have any tasks to take care of?",
  "Anything I need to deal with?",
  "Which task is waiting on me?",
] as const;
const scopeCall=call("declare_request_scope",{goals:[requested()]},"scope");
const teamCall=call("get_team",{status:"needs_you",view:"tasks",agent:"all",limit:5},"team");
type AuditOutcome={goals:RequestedGoal[];complete?:boolean;ambiguous?:boolean};
function fixture(options:{
  text?:string;audit?:AuditOutcome;status?:"needs_owner"|"needs_response";
  empty?:boolean;locale?:"en"|"es"|"ar";
}={}){
  const diagnostics:SupervisorDiagnostic[]=[];
  const read=vi.fn(async()=>({available:true,value:options.empty?[]:[
    persisted(options.status??"needs_owner","price:latte:review-1"),
  ],quality}));
  const requests:Array<Record<string,unknown>>=[];
  const transport=vi.fn(async(_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body)) as Record<string,unknown>;
    requests.push(body);
    if((body.text as {format?:{name?:string}})?.format?.name==="supervisor_scope_audit"){
      const audit=options.audit??{goals:[requested()]};
      return auditResponse(audit.goals,audit.complete??true,audit.ambiguous??false);
    }
    if(body.tool_choice==="required")return modelResponse([scopeCall,teamCall]);
    return finalResponse();
  });
  const execute=()=>runSupervisorTurn({
    text:options.text??phrases[0],locale:options.locale??"en",asOf:"2026-10-12",
    cafeName:"Fixture",timezone:"America/Los_Angeles",history:[],
    readRules:async()=>[],tools:{getTeamTasks:read} as unknown as BusinessScopedCafeTools,
    onDiagnostic:diagnostic=>diagnostics.push(diagnostic),
  },transport);
  return {execute,read,transport,diagnostics,requests};
}
describe("Direct owner-action Team question — complete mocked provider/model loop",()=>{
  it("case A: exact reproduced utterance -> independent team audit -> count + exact trusted card, no clarification",async()=>{
    const h=fixture();
    const {reply,usage}=await h.execute();
    expect(reply.status).toBe("verified");
    expect(reply.blocks).toContainEqual(expect.objectContaining({type:"count",value:1,label:"AI Team"}));
    expect(reply.blocks).toContainEqual(expect.objectContaining({
      type:"task_card",taskId:"price:latte:review-1",agent:"alex",
      status:"needs_owner",href:expect.stringContaining("task=price%3Alatte%3Areview-1"),
    }));
    const card=reply.blocks.find(b=>b.type==="task_card");
    expect(card?.type==="task_card"&&card.href.startsWith("/operations?")).toBe(true);
    expect(card?.type==="task_card"&&card.href.endsWith("#selected-task")).toBe(true);
    expect(JSON.stringify(reply)).not.toContain("Please ask the parts separately");
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.requests).toHaveLength(3);
    expect(usage.toolCallCount).toBe(1);
    expect(h.diagnostics).toContainEqual(expect.objectContaining({
      stage:"scope_reconciliation",reconciliationOutcome:"accepted",scopeAuditComplete:true,
      scopeAuditAmbiguous:false,declaredGoalDomains:["team"],auditedGoalDomains:["team"],
      normalizedGoalDomains:["team"],
    }));
  });
  it("case B: same Team snapshot with different audit period remains accepted",async()=>{
    const h=fixture({audit:{goals:[requested("team","month_to_date")]}});
    const answer=await h.execute();
    expect(answer.reply.blocks.some(b=>b.type==="task_card")).toBe(true);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.diagnostics).toContainEqual(expect.objectContaining({
      stage:"scope_reconciliation",reconciliationOutcome:"accepted",
    }));
  });
  it.each(phrases)("case C: %s follows the identical Team-only semantic contract in the full loop",async text=>{
    const h=fixture({text,audit:{goals:[requested("team","month_to_date")]}});
    const {reply}=await h.execute();
    expect(reply.blocks.some(b=>b.type==="task_card")).toBe(true);
    expect(h.read).toHaveBeenCalledTimes(1);
    const first=h.requests[0].instructions as string;
    const audit=h.requests[1].instructions as string;
    expect(first).toContain(SUPERVISOR_SCOPE_TAXONOMY);
    expect(audit).toContain(SUPERVISOR_SCOPE_TAXONOMY);
    expect(h.requests[1]).not.toHaveProperty("tools");
    expect(h.diagnostics.some(d=>d.reconciliationOutcome==="accepted")).toBe(true);
  });
  it.each(["needs_owner","needs_response"] as const)("Needs You includes persisted %s",async status=>{
    const h=fixture({status});
    const answer=await h.execute();
    expect(answer.reply.blocks).toContainEqual(expect.objectContaining({
      type:"task_card",status,taskId:"price:latte:review-1",
    }));
    expect(answer.reply.blocks).toContainEqual(expect.objectContaining({
      type:"count",value:1,
    }));
    expect(h.read).toHaveBeenCalledTimes(1);
  });
  it("verified empty inbox returns localized, grounded zero without generic unavailable",async()=>{
    for(const [locale,statement] of [
      ["en","No AI Team tasks currently need your attention."],
      ["es","Actualmente no hay tareas del equipo de IA que requieran tu atención."],
      ["ar","لا توجد حاليًا مهام لفريق الذكاء الاصطناعي تحتاج إلى اهتمامك."],
    ] as const){
      const h=fixture({empty:true,locale});
      const {reply}=await h.execute();
      expect(reply.status).toBe("verified");
      expect(reply.blocks).toContainEqual(expect.objectContaining({
        type:"count",value:0,
      }));
      expect(reply.blocks).toContainEqual({type:"text",text:statement});
      expect(reply.blocks.some(b=>b.type==="task_card")).toBe(false);
      expect(h.read).toHaveBeenCalledTimes(1);
    }
  });
  it.each([
    {name:"previously overcautious ambiguous audit",audit:{goals:[requested()],complete:true,ambiguous:true},outcome:"audit_ambiguous"},
    {name:"incomplete audit",audit:{goals:[requested()],complete:false,ambiguous:false},outcome:"audit_incomplete"},
    {name:"competing staffing interpretation",audit:{goals:[requested("staff_coverage")],complete:true,ambiguous:false},outcome:"semantic_conflict"},
    {name:"competing overview interpretation",audit:{goals:[requested("overview")],complete:true,ambiguous:false},outcome:"semantic_conflict"},
  ])("$name still fails closed before ANY persisted task read and explains why in safe diagnostics",async x=>{
    const h=fixture({audit:x.audit});
    const answer=await h.execute();
    expect(answer.reply.status).toBe("unavailable");
    expect(answer.reply.blocks[0]).toMatchObject({type:"text",
      text:expect.stringContaining(x.outcome==="semantic_conflict"
        ? "Which dates and financial measure" : "Which exact dates or business result")});
    expect(h.read).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(2);
    const diagnostic=h.diagnostics.find(d=>d.stage==="scope_reconciliation");
    expect(diagnostic?.reconciliationOutcome).toBe(x.outcome);
    const lines:string[]=[];
    const logger=createSupervisorDiagnosticLogger(line=>lines.push(line));
    if(diagnostic)logger.emit(diagnostic);
    expect(lines.join("")).not.toContain(phrases[0]);
    expect(lines.join("")).not.toContain("Latte");
    expect(lines.join("")).not.toContain("authorized-fixture-business");
    expect(lines.join("")).toContain('"reconciliationOutcome"');
  });
});
describe("Shared planner/auditor goal taxonomy is semantic, not a string router",()=>{
  it("distinguishes Team action, staff coverage FACT, overview, menu and pricing in both requests",()=>{
    const first=buildSupervisorInstructions({locale:"en",asOf:"2026-10-12",timezone:"America/Los_Angeles"});
    const audit=buildSupervisorScopeAuditRequest({model:"gpt-6-luna",text:phrases[0],
      locale:"en",asOf:"2026-10-12",timezone:"America/Los_Angeles"}).instructions;
    for(const instructions of [first,audit]){
      expect(instructions).toContain(SUPERVISOR_SCOPE_TAXONOMY);
      for(const term of ["TEAM =","STAFF OPERATIONAL FACTS =","OVERVIEW =","MENU CATALOG =","PRICING DECISION EVIDENCE ="]){
        expect(instructions).toContain(term);
      }
      expect(instructions).toContain("never collapse four requested domains");
    }
    expect(audit).toContain("ambiguous=true ONLY");
    expect(audit).toContain("complete=false ONLY");
  });
});
