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
 it.each([
  ["en","almond milk"],["es","leche de almendra"],["ar","حليب اللوز"]
 ] as const)("renders the resolved milk label in %s without raw template",async(locale,milk)=>{
  const ctx={resolveState:newResolveState("Switch 16 oz to almond milk"),locale} as AgentToolContext;
  const card=await askOwnerTools.ask_owner.execute({kind:"facts",question:"What cost?",
   options:[],allowOther:false,fields:[{key:"milk_almond_serving_cost_cents:16oz",
    label:"Unsafe model label",inputType:"money",units:[],defaultUnit:""}]},ctx);
  expect(card.missing).toEqual([]);
  const label=(card.fields as Array<{label:string}>)[0].label;
  expect(label).toContain(milk);
  expect(label).toContain("16 oz");
  expect(label).not.toContain("{milk}");
  expect(label).not.toContain("Unsafe model label");
 });
 it("supports six typed fields for a new noncatalog question",async()=>{
  const ctx={resolveState:newResolveState("Tell me about deliveries"),locale:"es"} as AgentToolContext;
  const kinds=["number","money","percent","text","date","choice"] as const;
  const fields=kinds.map((kind,i)=>({key:"supplier_"+i,label:"Field "+i,inputType:kind,units:[],defaultUnit:"",
    ...(kind==="choice"?{choices:[{label:"A",value:"a"},{label:"B",value:"b"}]}:{})}));
  const card=await askOwnerTools.ask_owner.execute({kind:"facts",question:"¿Datos?",options:[],allowOther:false,fields},ctx);
  expect(card).toMatchObject({kind:"facts",missing:[]});
  expect(Array.isArray(card.fields)&&card.fields.length).toBe(6);
  expect(typeof card.questionId).toBe("string");
 });

 it("rejects fewer than two or more than twelve options",()=>{
  expect(askOwnerSchema.safeParse({question:"Which?",options:options.slice(0,1),allowOther:true}).success).toBe(false);
  expect(askOwnerSchema.safeParse({question:"Which?",options:Array.from({length:13},(_,i)=>({label:"Latte "+i,value:String(i)})),allowOther:true}).success).toBe(false);
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
 it("allows verified numeric closing-count fills once and rejects unobserved amounts",async()=>{
  const id="33333333-3333-4333-8333-333333333333",date="2026-10-25";
  const ctx={resolveState:newResolveState("How much milk remains?")} as AgentToolContext;
  observeToolResult(ctx.resolveState,{source:"usage_variance",period:{from:date,to:date},
   missing:["endCount:"+date],rows:[{ingredientId:id,name:"Milk",unit:"ml",
    missing:["endCount:"+date]}]});
  const input={kind:"fill",question:"How much milk remains?",options:[],allowOther:false,
   fields:[{key:"endCount:"+id+":"+date,label:"Milk at closing",inputType:"number",
    units:["ml","l"],defaultUnit:"ml"}]};
  expect(askOwnerSchema.safeParse(input).success).toBe(true);
  const first=await askOwnerTools.ask_owner.execute(input,ctx);
  expect(first).toMatchObject({kind:"fill",missing:[]});
  expect((await askOwnerTools.ask_owner.execute(input,ctx)).missing).toContain("alreadyAsked");
  const notObserved={resolveState:newResolveState("hi")} as AgentToolContext;
  expect((await askOwnerTools.ask_owner.execute(input,notObserved)).missing).toContain("noMissingInput");
 });
 it("requires candidates observed this turn",async()=>{
  const ctx={resolveState:newResolveState("hello")} as AgentToolContext;
  expect((await askOwnerTools.ask_owner.execute({question:"Which?",options,allowOther:true},ctx)).missing).toContain("noAmbiguity");
 });
 it("requires the exact candidate label paired with its real ID",async()=>{
   const ctx=context();
   const wrongLabel=await askOwnerTools.ask_owner.execute({question:"Which?",options:[
     {label:"Iced Latte",value:hot},options[1]],allowOther:true},ctx);
   expect(wrongLabel.missing).toContain("unverifiedOption");
   const another=context();
   observeToolResult(another.resolveState,{source:"employees",missing:[],needsOwnerChoice:true,
     candidates:[{id:"33333333-3333-4333-8333-333333333333",label:"Maria A",detail:"Barista"},
       {id:"44444444-4444-4444-8444-444444444444",label:"Maria B",detail:"Manager"}]});
   const mixed=await askOwnerTools.ask_owner.execute({question:"Which?",options:[
     options[0],{label:"Maria B",value:"44444444-4444-4444-8444-444444444444"}],allowOther:false},another);
   expect(mixed.missing).toContain("unverifiedOption");
 });
});
