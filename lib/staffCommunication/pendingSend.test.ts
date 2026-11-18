import {describe,it,expect,vi} from "vitest";
import {crewOutboxKey,crewRejectedDraftKey,loadCrewPending,parseCrewPending,saveCrewPending,
 sameCrewOperation,deliverCrewWithRetry,type PendingCrewSubmission,
 type CrewOutboxStorage} from "./pendingSend";
const nonce="11111111-1111-4111-8111-111111111111";
const id="22222222-2222-4222-8222-222222222222";
const payload:PendingCrewSubmission={requestId:null,response:"report",
 body:"I cannot work the early hours today",nonce};
const store=():CrewOutboxStorage=>{
 const data=new Map<string,string>();
 return {getItem:key=>data.get(key)??null,setItem:(key,value)=>{data.set(key,value);},
  removeItem:key=>{data.delete(key);}};
};
describe("Task13C durable per-tab crew submission",()=>{
 it("reuses the same payload+nonce after a committed save loses its HTTP reply",async()=>{
  const sent:PendingCrewSubmission[]=[];
  const storage=store(),key=crewOutboxKey("authenticated-user-a");
  saveCrewPending(storage,key,payload);
  let records=0;
  const pause=vi.fn().mockResolvedValue(undefined);
  const receipt=await deliverCrewWithRetry(payload,async op=>{
   sent.push({...op});
   if(records===0){records++;throw new Error("HTTP acknowledgement lost");}
   return {id,replayed:true};
  },pause);
  expect(receipt).toEqual({status:"confirmed",receipt:{id,replayed:true}});
  expect(records).toBe(1);
  expect(sent).toEqual([payload,payload]);
  expect(pause).toHaveBeenCalledTimes(1);
  expect(pause).toHaveBeenCalledWith(400);
  // UI clears the outbox only after a valid real server receipt.
  expect(loadCrewPending(storage,key)).toEqual(payload);
  storage.removeItem(key);
  expect(loadCrewPending(storage,key)).toBeNull();
 });
 it("survives reload and refuses to invent an identity for a different message",async()=>{
  const storage=store(),key=crewOutboxKey("authenticated-user-b");
  saveCrewPending(storage,key,payload);
  const restored=loadCrewPending(storage,key);
  expect(restored).toEqual(payload);
  const next={...payload,body:"A different report",nonce:"33333333-3333-4333-8333-333333333333"};
  expect(sameCrewOperation(restored,next)).toEqual(payload);
  const attempted:PendingCrewSubmission[]=[];
  const pauses:number[]=[];
  const confirmed=await deliverCrewWithRetry(restored!,async original=>{
   attempted.push({...original});
   throw new Error("network offline");
  },async ms=>{pauses.push(ms);});
  expect(confirmed).toEqual({status:"unconfirmed"});
  expect(attempted).toEqual([payload,payload,payload]);
  expect(pauses).toEqual([400,1200]);
  expect(loadCrewPending(storage,key)).toEqual(payload);
  expect(loadCrewPending(storage,crewOutboxKey("a-different-auth-user"))).toBeNull();
 });
 it("requires a complete database receipt, not a generic successful HTTP status",async()=>{
  const post=vi.fn().mockResolvedValue({ok:true});
  const result=await deliverCrewWithRetry(payload,post,async()=>{});
  expect(result).toEqual({status:"unconfirmed"});
  expect(post).toHaveBeenCalledTimes(3);
 });
 it("frees definitive stale requests without retrying or changing the old nonce",async()=>{
  const attempts:PendingCrewSubmission[]=[];
  const pause=vi.fn();
  const result=await deliverCrewWithRetry(payload,async value=>{
   attempts.push({...value});
   return {error:"stale_request"};
  },pause);
  expect(result).toEqual({status:"stale_request"});
  expect(attempts).toEqual([payload]);
  expect(pause).not.toHaveBeenCalled();
  expect(crewRejectedDraftKey("user-a")).not.toBe(crewRejectedDraftKey("user-b"));
  const storage=store();
  storage.setItem(crewRejectedDraftKey("user-a"),payload.body!);
  expect(storage.getItem(crewRejectedDraftKey("user-a"))).toBe(payload.body);
  expect(storage.getItem(crewRejectedDraftKey("user-b"))).toBeNull();
 });
 it("does not unlock ambiguous nonce conflicts and keeps identical retry identity",async()=>{
  const attempts:PendingCrewSubmission[]=[];
  const result=await deliverCrewWithRetry(payload,async value=>{
   attempts.push({...value});
   throw new Error("409 nonce_conflict or response lost");
  },async()=>{});
  expect(result).toEqual({status:"unconfirmed"});
  expect(attempts).toEqual([payload,payload,payload]);
 });
 it("never restores malformed, mismatched, or overlong outbox payloads",()=>{
  expect(parseCrewPending(null)).toBeNull();
  expect(parseCrewPending("not-json")).toBeNull();
  expect(parseCrewPending(JSON.stringify({...payload,nonce:"nope"}))).toBeNull();
  expect(parseCrewPending(JSON.stringify({...payload,response:"confirm"}))).toBeNull();
  expect(parseCrewPending(JSON.stringify({...payload,body:"X".repeat(2001)}))).toBeNull();
  expect(parseCrewPending(JSON.stringify({...payload,response:"message",requestId:null}))).toBeNull();
  expect(parseCrewPending(JSON.stringify(payload))).toEqual(payload);
  const unavailable: CrewOutboxStorage={
   getItem:()=>null,removeItem:()=>{},setItem:()=>{throw new Error("storage denied");}};
  expect(()=>saveCrewPending(unavailable,"key",payload)).toThrow("storage denied");
  // A blocked browser store must stop the UI BEFORE it sends any request.
 });
});
