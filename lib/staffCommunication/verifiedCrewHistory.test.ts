import {describe,it,expect} from "vitest";
import {confirmedCrewMessage,visibleCrewHistory} from "./verifiedCrewHistory";
import type {PendingCrewSubmission} from "./pendingSend";
const workerA="11111111-1111-4111-8111-111111111111";
const workerB="22222222-2222-4222-8222-222222222222";
const id="33333333-3333-4333-8333-333333333333";
const op:PendingCrewSubmission={
 requestId:"44444444-4444-4444-8444-444444444444",
 response:"decline",body:"I can arrive at 8 AM",
 nonce:"55555555-5555-4555-8555-555555555555",
};
describe("verified staff reply history",()=>{
 it("shows exact stored-receipt message immediately, scoped only to that authenticated worker",()=>{
  const confirmed=confirmedCrewMessage(workerA,op,{id,replayed:false},"2026-11-22T12:30:00Z");
  expect(visibleCrewHistory(workerA,[],[confirmed])).toMatchObject([{
   id,request_id:op.requestId,body:op.body,actor:"employee",response_code:"decline",
  }]);
  expect(visibleCrewHistory(workerB,[],[confirmed])).toEqual([]);
 });
 it("prefers authoritative server history when RSC catches up, never duplicates a nonce-replayed receipt",()=>{
  const verified=confirmedCrewMessage(workerA,op,{id,replayed:true},"2026-11-22T12:30:00Z");
  const server={...verified.message,received_at:"2026-11-22T12:28:00Z",channel:"web"};
  expect(visibleCrewHistory(workerA,[server],[verified,verified])).toEqual([server]);
  expect(visibleCrewHistory(workerA,[],[verified,verified])).toEqual([verified.message]);
 });
 it("does not expose a previously confirmed worker's history to a switched account",()=>{
  const first=confirmedCrewMessage(workerA,op,{id,replayed:false},"2026-11-22T12:30:00Z");
  const second=confirmedCrewMessage(workerB,{...op,body:"My own report"},
   {id:"66666666-6666-4666-8666-666666666666",replayed:false},"2026-11-22T12:31:00Z");
  expect(visibleCrewHistory(workerB,[],[first,second]).map(row=>row.body)).toEqual(["My own report"]);
 });
});
