import test from "node:test";
import assert from "node:assert/strict";
import {STAFF_QUESTION_CASES,requireStaffQuestionDraft,requireOwnerAnswer} from "./staff-question.mjs";
const scope={businessId:"caf-A",ownerId:"owner-A",threadId:"thread-A",sourceId:"task-A",employeeId:"staff-A",sourceRevision:"2026-11-21T20:00:00Z"};
const row={id:"proposal-A",business_id:scope.businessId,owner_user_id:scope.ownerId,
 thread_id:scope.threadId,capability_id:"olivia.staff_question.v1",status:"draft",
 canonical_effect_payload:{sourceKind:"operating_task",sourceTaskId:scope.sourceId,
 employeeId:scope.employeeId,sourceRevision:scope.sourceRevision,
 question:"How many takeaway cups remain?",evidence:[{source:"order_lines",asOf:scope.sourceRevision}]}};
test("real-Luna suite registers positive, owner text, ambiguous and two-cafe checks",()=>{
 assert.deepEqual(STAFF_QUESTION_CASES.map(c=>c.id),[
  "proposal_owner_click_employee_reply","ordinary_owner_chat_answer",
  "ambiguous_or_unrelated_owner_turn","two_cafe_isolation_and_no_unapproved_send"]);
});
test("never accepts a proposed question already dispatched before owner click",()=>{
 assert.equal(requireStaffQuestionDraft([row],scope,0).id,row.id);
 assert.throws(()=>requireStaffQuestionDraft([row],scope,1),/unapproved_contact/);
 assert.throws(()=>requireStaffQuestionDraft([row,{...row,id:"proposal-B"}],scope,0),/draft_count/);
});
test("proposal binds owner, cafe, original source, timestamp and selected worker",()=>{
 for(const changed of [
  {...row,business_id:"caf-B"},{...row,owner_user_id:"owner-B"},
  {...row,thread_id:"thread-B"},{...row,status:"committed"},
  {...row,canonical_effect_payload:{...row.canonical_effect_payload,sourceTaskId:"task-B"}},
  {...row,canonical_effect_payload:{...row.canonical_effect_payload,employeeId:"staff-B"}},
  {...row,canonical_effect_payload:{...row.canonical_effect_payload,sourceRevision:"2026-11-22T20:00:00Z"}},
  {...row,canonical_effect_payload:{...row.canonical_effect_payload,evidence:[]}}
 ])assert.throws(()=>requireStaffQuestionDraft([changed],scope,0),/wrong_owner_cafe_source_or_worker/);
});
test("natural owner answer preserves exact saved message and unverified provenance without dispatch",()=>{
 const evidence={source:"owner_report",facts:{ownerUserId:"owner-A",ownerMessageId:"message-A",
  proposalId:"proposal-A",answer:"40 cups",independentlyVerified:false}};
 const task={owner_user_id:"owner-A",evidence:[evidence]};
 const input={ownerId:"owner-A",ownerMessageId:"message-A",proposalId:"proposal-A",answer:"40 cups"};
 assert.doesNotThrow(()=>requireOwnerAnswer(task,input,0));
 for(const diff of [{...input,ownerMessageId:"message-B"},{...input,answer:"41 cups"},
  {...input,proposalId:"proposal-B"},{...input,ownerId:"owner-B"}])
  assert.throws(()=>requireOwnerAnswer(task,diff,0),/owner_answer_provenance/);
 assert.throws(()=>requireOwnerAnswer({...task,evidence:[{...evidence,facts:{...evidence.facts,independentlyVerified:true}}]},input,0),/owner_answer_provenance/);
 assert.throws(()=>requireOwnerAnswer(task,input,1),/owner_answer_provenance/);
});
