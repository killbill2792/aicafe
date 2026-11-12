import {describe,expect,it,vi} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import type {OperatingTask} from "@/lib/operating/tasks";
import {settleInboxTasks} from "@/lib/operating/inboxLifecycle";
vi.mock("server-only",()=>({}));
import {nextOwnerPriceReminder,toastObservationNoticeKey,postVerifiedSourceReminder} from "./experimentNotices.server";
vi.mock("@/lib/operating/notifyOwner.server",()=>({notifyOwner:async(
 _db:unknown,notice:{kind:string},write:()=>Promise<unknown>)=>{
  if(notice.kind!=="commitment")throw Error("Unsupported notice type");
  return {decision:"posted",result:await write()};
 }}));
const base={businessId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
 ownerUserId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
 proposalId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
 approvedAt:"2026-03-08T09:00:00Z",timezone:"America/Los_Angeles",
 sourceVerified:false,cancelled:false,prior:[]};
describe("Task 8a owner notice exact source/day/slot identity",()=>{
 it("waits for two real elapsed hours after approval despite spring DST",()=>{
  expect(nextOwnerPriceReminder({...base,now:"2026-03-08T10:59:59Z"})).toBeNull();
  expect(nextOwnerPriceReminder({...base,now:"2026-03-08T11:00:00Z"})).toMatchObject({
   kind:"price_reminder",slot:1,localDate:"2026-03-08"});
 });
 it("limits reminder slots by owner/experiment and café-local date",()=>{
  expect(nextOwnerPriceReminder({...base,now:"2026-03-08T12:59:59Z",
   prior:[{localDate:"2026-03-08",slot:1}]})).toBeNull();
  expect(nextOwnerPriceReminder({...base,now:"2026-03-08T13:00:00Z",
   prior:[{localDate:"2026-03-08",slot:1}]})).toMatchObject({slot:2});
  expect(nextOwnerPriceReminder({...base,now:"2026-03-08T20:00:00Z",
   prior:[{localDate:"2026-03-08",slot:1},{localDate:"2026-03-08",slot:2}]})).toBeNull();
 });
 it("spaces the second reminder by at least two hours on the next local morning",()=>{
  const first={localDate:"2026-03-09",slot:1,postedAt:"2026-03-09T16:00:00Z"};
  expect(nextOwnerPriceReminder({...base,now:"2026-03-09T17:59:59Z",
   prior:[first]})).toBeNull();
  expect(nextOwnerPriceReminder({...base,now:"2026-03-09T18:00:00Z",
   prior:[first]})).toMatchObject({slot:2,localDate:"2026-03-09"});
 });
 it("does not send a second slot fifteen minutes after a near-midnight prior-day post",()=>{
  const prior=[{localDate:"2026-03-08",slot:2,postedAt:"2026-03-09T06:45:00Z"}];
  expect(nextOwnerPriceReminder({...base,now:"2026-03-09T07:00:00Z",
    prior})).toBeNull();
  expect(nextOwnerPriceReminder({...base,now:"2026-03-09T08:45:00Z",
    prior})).toMatchObject({localDate:"2026-03-09",slot:1});
 });
 it("allows a new morning after yesterday's limit and stops when verified",()=>{
  const prior=[{localDate:"2026-03-08",slot:1},{localDate:"2026-03-08",slot:2}];
  expect(nextOwnerPriceReminder({...base,now:"2026-03-09T16:00:00Z",prior}))
   .toMatchObject({localDate:"2026-03-09",slot:1});
  expect(nextOwnerPriceReminder({...base,now:"2026-03-09T16:00:00Z",prior,
   sourceVerified:true})).toBeNull();
  expect(nextOwnerPriceReminder({...base,now:"2026-03-09T16:00:00Z",prior,
   cancelled:true})).toBeNull();
 });
 it("keeps source history events independent from approved experiment IDs",()=>{
  const event={businessId:base.businessId,ownerUserId:base.ownerUserId,
   priceHistoryId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
   localDate:"2026-11-11"};
  expect(toastObservationNoticeKey({...event,windowIndex:0})).toMatchObject({
   kind:"toast_price_initial",slot:0,sourceId:event.priceHistoryId});
  expect(toastObservationNoticeKey({...event,windowIndex:3})).toMatchObject({
   kind:"toast_price_daily"});
  expect(toastObservationNoticeKey({...event,windowIndex:7,final:true})).toMatchObject({
   kind:"toast_price_final"});
  expect(()=>toastObservationNoticeKey({...event,windowIndex:8})).toThrow();
 });
});

describe("Task 8a actual notice write and durable delivery",()=>{
 it("writes a supported Operations kind and marks posted only after the inbox + chat",async()=>{
  const effects:string[]=[];
  const calls:{kind?:string;origin?:string;owner_user_id?:string;payload?:{title?:string}}[]=[];
  const receipts={state:"claimed"};
  const query=(answer:unknown)=>({eq:()=>query(answer),select:()=>query(answer),
    maybeSingle:async()=>({data:answer,error:null})});
  const db={
   rpc:async(name:string)=>{effects.push("claim:"+name);
    return {data:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",error:null};},
   from:(table:string)=>{
    if(table==="supervisor_experiment_notice_receipts")return {
     select:()=>({eq:()=>({eq:()=>({eq:()=>({eq:()=>({eq:async()=>({
      data:[],error:null})})})})})}),
     update:(value:{state:string})=>{effects.push("receipt:"+value.state);
      receipts.state=value.state;
      return {eq:()=>({eq:()=>({eq:()=>({select:()=>query({id:"receipt"})})})})};
     },
    };
    if(table==="operating_tasks")return {upsert:async(value:{
      kind:string;origin:string;owner_user_id:string;payload:{title:string}})=>{
     effects.push("task:"+value.kind);
     calls.push({kind:value.kind,origin:value.origin,
      owner_user_id:value.owner_user_id,payload:{title:value.payload.title}});
     return {error:null};}};
    if(table==="ai_messages")return {insert:async()=>{effects.push("message");return {error:null};}};
    throw Error("Unexpected table "+table);
   },
  };
  const posted=await postVerifiedSourceReminder(db as unknown as SupabaseClient,{
   businessId:base.businessId,ownerUserId:base.ownerUserId,proposalId:base.proposalId,
   threadId:"ffffffff-ffff-4fff-8fff-ffffffffffff",
   productId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
   productName:"Latte",targetPriceCents:550,currency:"USD",
   approvedAt:base.approvedAt,now:"2026-03-08T11:00:00Z",
   timezone:base.timezone,sourceVerified:false,cancelled:false,
  });
  expect(posted).toBe("posted");
  expect(calls).toEqual([{kind:"commitment",origin:"supervisor_followup",
   owner_user_id:base.ownerUserId,payload:{title:"Publish Latte price in Toast"}}]);
  const task={id:"price-reminder:"+base.proposalId+":2026-03-08:1",
   businessId:base.businessId,ownerUserId:base.ownerUserId,
   agentId:"alex",kind:"commitment",status:"needs_owner",
   payload:{title:"Publish Latte price in Toast",threadId:"thread"},
   confidence:"low",evidence:[],createdAt:"2026-03-08T11:00:00Z"} as OperatingTask;
  expect(settleInboxTasks([task],[],new Date("2026-03-08T12:00:00Z"),
   "2026-03-08")[0].status).toBe("needs_owner");
  expect(effects).toEqual(["claim:supervisor_8a_claim_notice","task:commitment",
   "message","receipt:posted"]);
  expect(receipts.state).toBe("posted");
 });
});
