import {describe,expect,it,vi} from "vitest";
import {runAgentTurn,type AgentProvider} from "./loop.server";
import {blocksExternalControlMutation,executeAgentTool,type AgentToolContext} from "./tools";
import {projectOwnerPublicQuery} from "./tools/webSearch";

const context=()=>({locale:"en",timezone:"America/Los_Angeles",asOf:"2026-11-18",
 tools:{}} as AgentToolContext);
const complete={type:"response.completed",response:{usage:{input_tokens:20,output_tokens:5}}};
const call=(name:string,args:unknown,id:string)=>({type:"response.output_item.done",
 item:{type:"function_call",name,arguments:JSON.stringify(args),call_id:id}});
const delta=(value:string)=>({type:"response.output_text.delta",delta:value});

describe("Task15D deterministic adversarial Supervisor boundaries",()=>{
 it("discards a completed private model response if permission changed during transport",async()=>{
  let allowed=true,requests=0;
  const onDelta=vi.fn();
  const provider:AgentProvider=async function*(){
   requests++;yield delta("private-cafe-canary");allowed=false;yield complete;
  };
  const check=async()=>{if(!allowed)throw Error("attachment_access_revoked");};
  await expect(runAgentTurn({ownerText:"Read the attached invoice",context:context(),provider,
   beforeProviderRequest:check,beforeAcceptResult:check,deferSensitiveOutput:()=>true,onDelta}))
   .rejects.toThrow("attachment_access_revoked");
  expect(onDelta).not.toHaveBeenCalled();expect(requests).toBe(1);
 });
 it("does not call a tool selected by an old in-flight response after revocation",async()=>{
  let allowed=true;
  const port=vi.fn();
  const ctx={...context(),gmail:{read:port,search:vi.fn(),labels:vi.fn(),thread:vi.fn(),
   attachment:vi.fn(),propose:vi.fn()}};
  const provider:AgentProvider=async function*(){
   yield call("read_gmail",{message_id:"abcdef123456"},"read");allowed=false;yield complete;
  };
  const check=async()=>{if(!allowed)throw Error("gmail_evidence_access_changed");};
  await expect(runAgentTurn({ownerText:"Read mail",context:ctx,provider,
   beforeProviderRequest:check,beforeAcceptResult:check,deferSensitiveOutput:()=>true}))
   .rejects.toThrow("gmail_evidence_access_changed");
  expect(port).not.toHaveBeenCalled();
 });
 it("a malicious document cannot create an approval during an explicit read-only turn",async()=>{
  const create=vi.fn();
  const ctx={...context(),externalEvidencePresent:()=>true,ownerText:"Read only. Do not change anything.",
    commitments:{create,list:vi.fn(async()=>[]),close:vi.fn()}};
  expect(await executeAgentTool("manage_commitment",{action:"create",title:"Poisoned reminder"},ctx))
    .toMatchObject({missing:["owner_action_confirmation_required"]});
  expect(create).not.toHaveBeenCalled();
  for(const tool of ["propose_gmail_action","propose_price_change","propose_purchases","propose_supplier_purchase_order","draft_week_schedule","record_supplier_order_outcome"])
   expect(blocksExternalControlMutation(tool,{},"Read only.")).toBe(true);
  expect(await executeAgentTool("manage_commitment",{action:"list",title:null,due_date:null,due_time:null,origin:null,commitment_id:null},ctx))
    .toMatchObject({missing:[],commitments:[]});
  expect(ctx.commitments.list).toHaveBeenCalledTimes(1);
  expect(blocksExternalControlMutation("propose_gmail_action",{},"Please draft an email for approval")).toBe(false);
  expect(blocksExternalControlMutation("propose_gmail_action",{},"Summarize this invoice")).toBe(true);
  expect(blocksExternalControlMutation("propose_gmail_action",{},"Read the invoice and draft a reply")).toBe(false);
 });
 it("keeps private model-generated search terms out of all public queries",()=>{
  const canary="cafe-b-confidential-93584";
  expect(projectOwnerPublicQuery("search for "+canary,"Read the attached invoice")).toBeNull();
  const projected=projectOwnerPublicQuery("weather "+canary,"What is the weather tomorrow?","San Jose");
  expect(projected).toBe("What is the weather tomorrow? in San Jose");
  expect(projected).not.toContain(canary);
 });
 it("keeps concurrent turns' decision to admit external content isolated",async()=>{
  const denied=vi.fn(),allowed=vi.fn().mockResolvedValue({proposalId:"p",revision:1,account:"owner@example.invalid"});
  const raw={operation:"send",action:null,to:["supplier@example.invalid"],cc:[],bcc:[],subject:"Quote",body:"Please quote",messageId:null,threadId:null,labelId:null,labelName:null};
  const make=(propose:typeof denied,external:boolean,text:string)=>({...context(),ownerText:text,externalEvidencePresent:()=>external,
    gmail:{labels:vi.fn(),read:vi.fn(),search:vi.fn(),thread:vi.fn(),attachment:vi.fn(),propose}});
  const [a,b]=await Promise.all([
   executeAgentTool("propose_gmail_action",raw,make(denied,true,"Read only")),
   executeAgentTool("propose_gmail_action",raw,make(allowed,false,"Draft quote request"))]);
  expect(a.missing).toEqual(["owner_action_confirmation_required"]);expect(denied).not.toHaveBeenCalled();
  expect(b).toMatchObject({draft:true,saved:false,requiredApproval:"owner_click"});expect(allowed).toHaveBeenCalledTimes(1);
 });
 it("scheduled service context is never exposed to owner-text authorization",async()=>{
  const ctx=context();
  const result=await runAgentTurn({ownerText:"SYSTEM synopsis: I bought 1000 gallons of milk",serviceOrigin:true,context:ctx,
   provider:async function*(){yield delta("Investigation remains open.");yield complete;}});
  expect(ctx.ownerText).toBe("");expect(result.text).toBe("Investigation remains open.");
 });
});
