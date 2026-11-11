import {describe,expect,it} from "vitest";
import {randomUUID} from "node:crypto";
import {applyThreadMemoryOperations,emptyThreadMemoryDocument,formatThreadMemory,historyContent,
  parseThreadMemoryDocument,safeThreadMemoryText,threadMemorySource,type ThreadMemoryOperation} from "./history";
import {agentReplyPayload} from "./persist.server";
import {newResolveState} from "./resolve";
import type {AgentTurn} from "./loop.server";

// A reply that is only a question is saved as the card alone. The AI's next turn must
// still see that question, or it forgets what it just asked the owner.
const questionId="11111111-1111-4111-8111-111111111111";
const hot="22222222-2222-4222-8222-222222222222",iced="33333333-3333-4333-8333-333333333333";
function questionOnly(result:Record<string,unknown>&{question:string}){
 const turn={text:result.question,endReason:"complete",status:{status:"complete",missing:[]},
  results:[{source:"ask_owner",period:null,missing:[],...result}],unverified:[],
  usage:{modelCalls:1,toolCalls:1,inputTokens:1,cachedTokens:0,outputTokens:1,latencyMs:1}} as unknown as AgentTurn;
 return {text:null,blocks:agentReplyPayload(turn).reply.blocks};
}
const facts=questionOnly({kind:"facts",questionId,question:"What is your monthly rent?",
 fields:[{key:"monthly_rent_cents",label:"Monthly rent",inputType:"money",units:[],defaultUnit:""}]});
const fill=questionOnly({kind:"fill",question:"How much oat milk is left?",
 fields:[{key:"endCount:44444444-4444-4444-8444-444444444444:2026-10-29",label:"Oat milk",inputType:"number",units:["L"],defaultUnit:"L"}]});
const choice=questionOnly({kind:"choice",question:"Which latte?",allowOther:true,
 options:[{label:"Latte — Hot",value:hot},{label:"Latte — Iced",value:iced}]});

describe("chat history the AI sees",()=>{
 it("includes a typed-answer question that was the whole reply",()=>{
  expect(facts.blocks.some(b=>"type" in b&&b.type==="text")).toBe(false);
  expect(historyContent(facts)).toBe("Question card (owner answers in its form): What is your monthly rent? Fields: Monthly rent");
  expect(historyContent(fill)).toBe("Question card (owner answers in its form): How much oat milk is left? Fields: Oat milk");
 });
 it("keeps the exact choice-card form the pick memory reads",()=>{
  expect(historyContent(choice)).toBe("Asked: Which latte? Options: Latte — Hot ("+hot+"); Latte — Iced ("+iced+")");
  const state=newResolveState("Latte — Iced",[{role:"assistant",content:historyContent(choice)}]);
  expect([...state.chosenIds]).toEqual([iced]);
 });
 it("a typed-answer question is never read as a choice and keeps an earlier latte pick",()=>{
  for(const card of [facts,fill])
   expect(historyContent(card)).not.toMatch(/Asked:|Options:/);
  const history=[{role:"assistant",content:historyContent(choice)},{role:"user",content:"Latte — Hot"},
   {role:"assistant",content:historyContent(facts)},{role:"user",content:"Monthly rent: 3000"}];
  expect([...newResolveState("draft price change approval",history).recentChoiceIds??[]]).toEqual([hot]);
 });
 it("keeps plain text and text blocks as before",()=>{
  expect(historyContent({text:"Sales were up.",blocks:null})).toBe("Sales were up.");
  expect(historyContent({text:null,blocks:[{type:"text",text:"Part one."},{type:"text",text:"Part two."}]})).toBe("Part one. Part two.");
  expect(historyContent({text:null,blocks:[{type:"proposal_card",proposalId:questionId}]})).toBe("");
 });
});


describe("rolling thread memory primitives",()=>{
 const owner=(text:string,createdAt=new Date().toISOString())=>({
  id:randomUUID(),role:"owner" as const,text,createdAt,
 });
 const remember=(source:ReturnType<typeof owner>,key:string,quote:string):ThreadMemoryOperation=>({
  action:"remember",kind:"preference",key,sourceMessageId:source.id,quote,
 });
 it("accepts only safe owner-authored nonfinancial source text",()=>{
  const source=owner("We prefer oat milk for staff drinks.");
  expect(threadMemorySource(source)).toEqual({id:source.id,createdAt:source.createdAt,text:source.text});
  expect(threadMemorySource({...source,role:"supervisor"})).toBeNull();
  expect(safeThreadMemoryText("Sales were $250 yesterday")).toBeNull();
  expect(safeThreadMemoryText("The API key is confidential")).toBeNull();
  expect(safeThreadMemoryText("We open at 7")).toBeNull();
  expect(safeThreadMemoryText("We prefer oat milk")).toBe("We prefer oat milk");
 });
 it("replaces a corrected key and forgets it without allowing old history to resurrect it",()=>{
  const first=owner("I prefer oat milk for staff drinks.",new Date(Date.now()-3000).toISOString());
  const correction=owner("I prefer almond milk for staff drinks.",new Date(Date.now()-2000).toISOString());
  const forget=owner("Forget that I prefer almond milk.",new Date(Date.now()-1000).toISOString());
  const key="preference:staff_drinks";
  let document=applyThreadMemoryOperations(emptyThreadMemoryDocument(),
   [remember(first,key,first.text)],[threadMemorySource(first)!]);
  document=applyThreadMemoryOperations(document,
   [remember(correction,key,correction.text)],[threadMemorySource(correction)!]);
  expect(document.entries.map(entry=>entry.text)).toEqual([correction.text]);
  document=applyThreadMemoryOperations(document,[{
   action:"forget",kind:"preference",key,sourceMessageId:forget.id,quote:"",
  }],[threadMemorySource(forget)!]);
  expect(document.entries).toEqual([]);
  expect(document.tombstones.map(item=>item.key)).toEqual([key]);
  document=applyThreadMemoryOperations(document,
   [remember(first,key,first.text)],[threadMemorySource(first)!]);
  expect(document.entries).toEqual([]);
  const restated=owner("I prefer soy milk for staff drinks.",new Date(Date.now()+1000).toISOString());
  document=applyThreadMemoryOperations(document,
   [remember(restated,key,restated.text)],[threadMemorySource(restated)!]);
  expect(document.entries.map(entry=>entry.text)).toEqual([restated.text]);
  expect(document.tombstones).toEqual([]);
 });
 it("rejects invented quotes, cross-kind keys and malformed persisted documents",()=>{
  const source=owner("We prefer oat milk for staff drinks.");
  const candidate=threadMemorySource(source)!;
  const rejected=applyThreadMemoryOperations(emptyThreadMemoryDocument(),[
   remember(source,"preference:staff_drinks","We prefer soy milk."),
   remember(source,"goal:staff_drinks",source.text),
   remember(source,"preference:staff_drinks",source.text+" invented"),
  ],[candidate]);
  expect(rejected.entries).toEqual([]);
  expect(parseThreadMemoryDocument(emptyThreadMemoryDocument())).toEqual(emptyThreadMemoryDocument());
  expect(parseThreadMemoryDocument({...emptyThreadMemoryDocument(),entries:[{
   kind:"preference",key:"preference:staff_drinks",text:"Monthly sales are high",
   sourceMessageId:source.id,sourceAt:source.createdAt,revision:1,
  }]})).toBeNull();
 });
 it("rejects extra persisted fields, duplicate keys and entries newer than the document revision",()=>{
  const source=owner("We prefer oat milk for staff drinks.");
  const entry={kind:"preference",key:"preference:staff_drinks",text:source.text,
   sourceMessageId:source.id,sourceAt:source.createdAt,revision:1};
  const base={...emptyThreadMemoryDocument(),revision:1,
   cursor:{createdAt:source.createdAt,id:source.id},entries:[entry]};
  expect(parseThreadMemoryDocument({...base,unexpected:true})).toBeNull();
  expect(parseThreadMemoryDocument({...base,entries:[entry,{...entry}]})).toBeNull();
  expect(parseThreadMemoryDocument({...base,entries:[{...entry,revision:2}]})).toBeNull();
  expect(parseThreadMemoryDocument({...base,entries:[entry],tombstones:[{
   key:"preference:staff_drinks",sourceMessageId:source.id,sourceAt:source.createdAt,revision:1,
  }]})).toBeNull();
 });
 it("formats only advisory nonfinancial entries and does not mutate the stored order",()=>{
  const first=owner("We prefer oat milk.");
  const second=owner("We prefer quiet morning music.");
  const operations=[remember(second,"preference:music",second.text),remember(first,"preference:milk",first.text)];
  const document=applyThreadMemoryOperations(emptyThreadMemoryDocument(),operations,
   [threadMemorySource(first)!,threadMemorySource(second)!]);
  const before=document.entries.map(entry=>entry.key);
  const formatted=formatThreadMemory(document);
  expect(formatted).toContain("advisory only");
  expect(formatted).toContain("We prefer oat milk.");
  expect(document.entries.map(entry=>entry.key)).toEqual(before);
 });
});
