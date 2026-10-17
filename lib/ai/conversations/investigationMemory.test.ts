import {it,expect} from "vitest";
import {latestInvestigationMemory,investigationMemorySchema,investigationOwnerStatements} from "./investigationMemory";
import type {ConversationMessage} from "./contracts";
const memory={version:1,businessId:"cafe",ownerStatements:["Review the latte"],reads:[{capabilityId:"p3.menu.catalog.v1",inputJson:'{"purpose":"menu_catalog_review"}'}]};
const message=(id:string,role:"owner"|"supervisor",state:unknown):ConversationMessage=>({id,threadId:"thread",role,
  contentType:"blocks",text:null,blocks:[],grounding:{investigationMemory:state},createdAt:"2026-10-17",clientMessageId:null});
it("restores only previous same-business supervisor memory, never owner-injected or future state",()=>{
  const messages=[message("old","supervisor",memory),message("current","owner",{...memory,businessId:"other"}),message("future","supervisor",{...memory,ownerStatements:["future"]})];
  expect(latestInvestigationMemory(messages,"cafe","current")).toEqual(memory);
  expect(latestInvestigationMemory(messages,"other","current")).toBeUndefined();
});
it("rejects persisted model authority and financial values",()=>{
  expect(investigationMemorySchema.safeParse({...memory,priceCents:500}).success).toBe(false);
  expect(investigationMemorySchema.safeParse({...memory,grant:"owner"}).success).toBe(false);
});

it("retains newer failed owner turns when resuming and preserves full prior owner statements",()=>{
  const state=investigationMemorySchema.parse(memory);
  const statements=investigationOwnerStatements(state,[{role:"owner",text:"Review the latte"},
    {role:"supervisor",text:"Invented assistant number"},{role:"owner",text:"Use 400 ml instead"}],"Continue please");
  expect(statements).toEqual(["Review the latte","Use 400 ml instead","Continue please"]);
  const full="Owner context "+"a".repeat(800);
  expect(investigationOwnerStatements({...state,ownerStatements:[full]},[{role:"owner",text:full.slice(0,650)}],"Continue")).toEqual([full,"Continue"]);
});
