import {describe,it,expect} from "vitest";
import {allowPendingStaffQuestionRead} from "./staffQuestionOwnerGate";
const owner={external:false,ownerRole:"owner",ownerContentType:"text",
 ownerInputResponse:false,ownerText:"40 takeaway cups",ownerId:"owner-message",
 ownerThreadId:"thread-1",threadId:"thread-1",durableFence:null,
 hasCheckpoint:false,job:null};
describe("staff question natural owner response admission",()=>{
 it("allows authenticated browser text but not prompt buttons or unrelated actors",()=>{
   expect(allowPendingStaffQuestionRead(owner)).toBe(true);
   for(const changed of [
     {ownerRole:"supervisor"},{ownerContentType:"blocks"},
     {ownerThreadId:"other-cafe-thread"},{ownerInputResponse:true},
     {ownerText:"   "},
   ])expect(allowPendingStaffQuestionRead({...owner,...changed})).toBe(false);
 });
 it("accepts real durable owner run only with claimed same-message same-thread job",()=>{
   const durable={...owner,external:true,durableFence:{jobId:"job-1"},
      hasCheckpoint:true,job:{id:"job-1",threadId:"thread-1",ownerMessageId:"owner-message"}};
   expect(allowPendingStaffQuestionRead(durable)).toBe(true);
   for(const changed of [
    {durableFence:null},{hasCheckpoint:false},{job:null},
    {job:{...durable.job,id:"job-2"}},
    {job:{...durable.job,ownerMessageId:"other-message"}},
    {job:{...durable.job,threadId:"other-thread"}},
   ])expect(allowPendingStaffQuestionRead({...durable,...changed})).toBe(false);
 });
 it("never treats an external connector or unclaimed run as owner answer authority",()=>{
   expect(allowPendingStaffQuestionRead({...owner,external:true})).toBe(false);
 });
});
