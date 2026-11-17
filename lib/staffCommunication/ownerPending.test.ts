import {describe,it,expect,vi} from "vitest";
import {ownerPendingKey,parseOwnerPending,loadOwnerPending,saveOwnerPending,
 type OwnerPendingMessage,type OwnerPendingAssignment} from "./ownerPending";
import {deliverVerifiedReceiptWithRetry,type CrewOutboxStorage} from "./pendingSend";
const ownerA="11111111-1111-4111-8111-111111111111";
const ownerB="22222222-2222-4222-8222-222222222222";
const cafeA="33333333-3333-4333-8333-333333333333";
const cafeB="44444444-4444-4444-8444-444444444444";
const employee="55555555-5555-4555-8555-555555555555";
const nonceMessage="66666666-6666-4666-8666-666666666666";
const nonceAssignment="77777777-7777-4777-8777-777777777777";
const receiptId="88888888-8888-4888-8888-888888888888";
const message:OwnerPendingMessage={type:"message",employeeId:employee,
 body:"Can you update me on the schedule?",nonce:nonceMessage};
const assignment:OwnerPendingAssignment={type:"assignment",employeeId:employee,
 workKind:"checklist",title:"Check grinder",prompt:"Inspect and report problems",nonce:nonceAssignment};
function store():CrewOutboxStorage{
 const data=new Map<string,string>();
 return {getItem:key=>data.get(key)??null,
 setItem:(key,value)=>{data.set(key,value);},
 removeItem:key=>{data.delete(key);}};
}
describe("Task13C owner outbox survives lost replies across reload",()=>{
 it.each([{kind:"message" as const,payload:message},{kind:"assignment" as const,payload:assignment}])
 ("retries identical $kind after HTTP acknowledgement loss, never creating second operation",async({kind,payload})=>{
  const storage=store(),key=ownerPendingKey(ownerA,cafeA,kind);
  saveOwnerPending(storage,key,payload);
  const restored=loadOwnerPending(storage,key,kind);
  expect(restored).toEqual(payload);
  const calls:unknown[]=[];
  let logicalCommits=0;
  const sleep=vi.fn().mockResolvedValue(undefined);
  const result=await deliverVerifiedReceiptWithRetry(restored!,async original=>{
   calls.push({...original});
   if(logicalCommits===0){logicalCommits++;throw Error("lost HTTP acknowledgement");}
   return {id:receiptId,replayed:true};
  },sleep);
  expect(result).toEqual({status:"confirmed",receipt:{id:receiptId,replayed:true}});
  expect(calls).toEqual([payload,payload]);
  expect(logicalCommits).toBe(1);
  expect(sleep).toHaveBeenCalledOnce();
  expect(sleep).toHaveBeenCalledWith(400);
  expect(loadOwnerPending(storage,key,kind)).toEqual(payload);
  storage.removeItem(key);
  expect(loadOwnerPending(storage,key,kind)).toBeNull();
 });
 it("stores independent message and assignment nonces, scoped to BOTH owner and cafe",()=>{
  const storage=store();
  const msg=ownerPendingKey(ownerA,cafeA,"message");
  const work=ownerPendingKey(ownerA,cafeA,"assignment");
  saveOwnerPending(storage,msg,message);
  saveOwnerPending(storage,work,assignment);
  expect(loadOwnerPending(storage,msg,"message")).toEqual(message);
  expect(loadOwnerPending(storage,work,"assignment")).toEqual(assignment);
  expect(loadOwnerPending(storage,msg,"assignment")).toBeNull();
  expect(loadOwnerPending(storage,ownerPendingKey(ownerB,cafeA,"message"),"message")).toBeNull();
  expect(loadOwnerPending(storage,ownerPendingKey(ownerA,cafeB,"message"),"message")).toBeNull();
  expect(loadOwnerPending(storage,ownerPendingKey(ownerA,cafeA,"message"),"message")).toEqual(message);
 });
 it("keeps original payload and exact nonce after repeated unknown outcomes",async()=>{
  const storage=store(),key=ownerPendingKey(ownerA,cafeA,"assignment");
  saveOwnerPending(storage,key,assignment);
  const attempts:unknown[]=[];
  const pauses:number[]=[];
  const result=await deliverVerifiedReceiptWithRetry(assignment,async op=>{
   attempts.push({...op});
   throw new Error("unknown transport or 409 nonce_conflict");
  },async ms=>{pauses.push(ms);});
  expect(result.status).toBe("unconfirmed");
  expect(attempts).toEqual([assignment,assignment,assignment]);
  expect(pauses).toEqual([400,1200]);
  expect(loadOwnerPending(storage,key,"assignment")).toEqual(assignment);
 });
 it("rejects malformed or substituted durable payload rather than overwriting uncertain work",()=>{
  expect(parseOwnerPending(null,"message")).toBeNull();
  expect(parseOwnerPending("broken","message")).toBeNull();
  expect(parseOwnerPending(JSON.stringify({...message,nonce:"unusable"}),"message")).toBeNull();
  expect(parseOwnerPending(JSON.stringify({...message,employeeId:"other"}),"message")).toBeNull();
  expect(parseOwnerPending(JSON.stringify({...message,body:"".padStart(2001,"x")}),"message")).toBeNull();
  expect(parseOwnerPending(JSON.stringify({...assignment,title:""}),"assignment")).toBeNull();
  expect(parseOwnerPending(JSON.stringify({...assignment,prompt:"x".repeat(2001)}),"assignment")).toBeNull();
  expect(parseOwnerPending(JSON.stringify({...assignment,workKind:"admin"}),"assignment")).toBeNull();
  expect(parseOwnerPending(JSON.stringify(message),"assignment")).toBeNull();
  expect(parseOwnerPending(JSON.stringify(assignment),"message")).toBeNull();
  const denied: CrewOutboxStorage={
   getItem:()=>null,removeItem:()=>{},setItem:()=>{throw Error("denied");}};
  expect(()=>saveOwnerPending(denied,"key",message)).toThrow("denied");
 });
});
