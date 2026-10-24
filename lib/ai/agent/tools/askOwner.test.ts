import {describe,it,expect} from "vitest";
import {askOwnerSchema,askOwnerTools} from "./askOwner";
import {newResolveState,observeToolResult} from "../resolve";
import type {AgentToolContext} from "./index";
const hot="11111111-1111-4111-8111-111111111111",iced="22222222-2222-4222-8222-222222222222";
const options=[{label:"Latte — Hot",value:hot},{label:"Latte — Iced",value:iced}];
function context(){
 const resolveState=newResolveState("raise latte to $5.50");
 observeToolResult(resolveState,{source:"menu_items",missing:[],needsOwnerChoice:true,
  candidates:[{id:hot,label:"Latte — Hot",detail:"Hot"},{id:iced,label:"Latte — Iced",detail:"Iced"}]});
 return {resolveState} as AgentToolContext;
}
describe("ask_owner tool",()=>{
 it("rejects fewer than two or more than four options",()=>{
  expect(askOwnerSchema.safeParse({question:"Which?",options:options.slice(0,1),allowOther:true}).success).toBe(false);
  expect(askOwnerSchema.safeParse({question:"Which?",options:[...options,...options,...options.slice(0,1)],allowOther:true}).success).toBe(false);
 });
 it("refuses invented UUIDs and duplicate labels",async()=>{
  const ctx=context();
  const invented=await askOwnerTools.ask_owner.execute({question:"Which?",options:[
   options[0],{label:"Other latte",value:"33333333-3333-4333-8333-333333333333"}],allowOther:true},ctx);
  expect(invented.missing).toContain("inventedOptionId");
  const duplicate=await askOwnerTools.ask_owner.execute({question:"Which?",options:[
   options[0],{label:options[0].label,value:iced}],allowOther:true},ctx);
  expect(duplicate.missing).toContain("duplicateLabels");
 });
 it("ends the choice once and rejects a second request",async()=>{
  const ctx=context();
  const first=await askOwnerTools.ask_owner.execute({question:"Which Latte?",options,allowOther:true},ctx);
  expect(first.missing).toEqual([]);
  expect(first.options).toEqual(options);
  const again=await askOwnerTools.ask_owner.execute({question:"Again?",options,allowOther:false},ctx);
  expect(again.missing).toContain("alreadyAsked");
 });
 it("requires candidates observed this turn",async()=>{
  const ctx={resolveState:newResolveState("hello")} as AgentToolContext;
  expect((await askOwnerTools.ask_owner.execute({question:"Which?",options,allowOther:true},ctx)).missing).toContain("noAmbiguity");
 });
});
