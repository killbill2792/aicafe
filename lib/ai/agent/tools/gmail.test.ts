import {describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import {gmailTools} from "./gmail";
import type {AgentToolContext} from "./index";
const context={timezone:"America/Los_Angeles",asOf:"2026-11-12",locale:"en",
 tools:{} as AgentToolContext["tools"]} satisfies AgentToolContext;
const input={operation:"send",action:null,to:["supplier@example.com"],cc:[],bcc:[],
 subject:"Approved order",body:"Your order is confirmed.",messageId:null,threadId:null,
 labelId:null,labelName:null};
describe("Gmail tools are owner scoped and inert",()=>{
 it("provides an honest missing-connection response, not a fake success",async()=>{
   const response=await gmailTools.propose_gmail_action.execute(input,context);
   expect(response).toMatchObject({missing:["gmail_not_connected"]});
 });
 it("only prepares an owner-click approval, never sends directly",async()=>{
   const propose=vi.fn().mockResolvedValue({proposalId:"11111111-1111-4111-8111-111111111111",
     revision:1,account:"owner@example.com"});
   const response=await gmailTools.propose_gmail_action.execute(input,{
     ...context,gmail:{propose,search:vi.fn(),read:vi.fn(),thread:vi.fn(),attachment:vi.fn()}
   });
   expect(propose).toHaveBeenCalledWith(input);
   expect(response).toMatchObject({draft:true,saved:false,requiredApproval:"owner_click"});
 });
 it("rejects spoofed recipients and invalid Gmail message ID syntax",async()=>{
   await expect(gmailTools.propose_gmail_action.execute({...input,to:["bad-address"]},context)).rejects.toThrow();
   await expect(gmailTools.read_gmail.execute({message_id:"?"},context)).rejects.toThrow();
 });
 it("search is bounded and invokes only the authorized reader",async()=>{
   const search=vi.fn().mockResolvedValue({messages:[],account:"owner@example.com"});
   const result=await gmailTools.search_gmail.execute({query:"invoice",limit:5},{
     ...context,gmail:{search,read:vi.fn(),thread:vi.fn(),attachment:vi.fn(),propose:vi.fn()}
   });
   expect(search).toHaveBeenCalledWith("invoice",5);
   expect(result).toMatchObject({missing:[],source:"gmail"});
 });
});
