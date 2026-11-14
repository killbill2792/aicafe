import test from "node:test";
import assert from "node:assert/strict";
import {toScaled,stockRows,expectedAfter,ledgerWrites,proposalLines,planOwnerApprovals,readPersistedModelUsage,requireCompletedTurn,verifyCheckoutHead,requireObservedProductionModel,allCasesAccountedFor,failureCode} from "./runner.mjs";

const milk={name:"Whole milk",base_unit:"ml",quantity_base:"5.2500"};
const beans={name:"Espresso beans",base_unit:"g",quantity_base:"12.5000"};
test("canonical stock has exact four-decimal scaled integer quantities",()=>{
 assert.equal(toScaled("1"),10000);
 assert.equal(toScaled("1.2345"),12345);
 assert.equal(toScaled("-3.1000"),-31000);
 assert.throws(()=>toScaled("1.23456"),/precision_not_canonical/);
 assert.throws(()=>toScaled("9000000000000000"),/stock_overflow/);
 const rows=stockRows([milk,beans]);
 assert.deepEqual(rows,[
  {ingredient:"espresso_beans",unit:"g_x10000",quantity:125000},
  {ingredient:"whole_milk",unit:"ml_x10000",quantity:52500}
 ]);
 assert.throws(()=>stockRows([milk,{...milk,quantity_base:"9.0000"}]),
  /ambiguous_ingredient/);
});
test("expected DB delta comes from human-labeled effect, never a model reply",()=>{
 const before=stockRows([milk,beans]);
 const expected=expectedAfter(before,[
  {sourceLineId:"human_line_1",ingredient:"whole_milk",unit:"ml_x10000",delta:37854118}
 ]);
 const row=expected.find(x=>x.ingredient==="whole_milk");
 assert.equal(row.quantity,37906618);
 assert.equal(before.find(x=>x.ingredient==="whole_milk").quantity,52500);
 assert.throws(()=>expectedAfter(before,[
  {ingredient:"unknown_item",unit:"ml_x10000",delta:10000}
 ]),/invalid_human_labeled_effect/);
});
test("write receipts originate only from actually new local ledger rows",()=>{
 const old=[{id:"old",line_id:"recorded",created_at:"2026-11-01T00:00:00Z",
  name:"Whole milk",base_unit:"ml",quantity_base:"1.0000",voided_at:null,cost_cents:null}];
 const received=[...old,{id:"receipt_1",line_id:"purchase_1",
  created_at:"2026-11-13T10:00:00Z",name:"Whole milk",base_unit:"ml",
  quantity_base:"2.0000",voided_at:null,cost_cents:400}];
 const expected=[{sourceLineId:"human_line_1",ingredient:"whole_milk",
  unit:"ml_x10000",delta:20000,costCents:400}];
 assert.deepEqual(ledgerWrites(old,received,expected),[{
  sourceLineId:"human_line_1",ingredient:"whole_milk",unit:"ml_x10000",
  delta:20000,receiptId:"receipt_1",status:"committed"
 }]);
 assert.deepEqual(ledgerWrites(old,old,expected),[]);
 const two=[...received,{id:"receipt_3",line_id:"purchase_3",
  created_at:"2026-11-13T09:00:00Z",name:"Espresso beans",
  base_unit:"g",quantity_base:"1.0000",voided_at:null,cost_cents:250}];
 const unorderedLabels=[...expected,{sourceLineId:"human_line_2",
  ingredient:"espresso_beans",unit:"g_x10000",delta:10000,costCents:250}];
 assert.deepEqual(ledgerWrites(old,two,unorderedLabels).map(x=>x.sourceLineId),
  ["human_line_2","human_line_1"]);

 assert.throws(()=>ledgerWrites(old,[...old,{...received[1],cost_cents:500}],expected),/saved_purchase_cost_mismatch/);
 assert.equal(ledgerWrites(old,[...received,{...received[1],id:"receipt_2",
  line_id:"purchase_2"}],expected)[1].sourceLineId,"unexpected_1");
});
test("proposal extraction never fabricates missing tool output",()=>{
 const one=[{id:"proposal_1",capability_id:"maya.inventory_purchase.v1",
  created_at:"2026-11-13T10:00:00Z",
  canonical_effect_payload:{name:"Whole milk",quantity:2,unit:"gal",
   costCents:1198,ingredientId:"ingredient_1",receiptLineIndex:0}}];
 assert.deepEqual(proposalLines([],one),[{
  lineId:"proposal_0",name:"Whole milk",quantity:2,unit:"gal",
  costCents:1198,confidence:"verified"
 }]);
 assert.deepEqual(proposalLines(one,one),[]);
 assert.equal(proposalLines([],one)[0].lineId,"proposal_0");
 // Ground truth cannot manufacture an observed proposal's identity.
 assert.equal(proposalLines([],one,[{lineId:"forged_label"}])[0].lineId,"proposal_0");
});

test("live results cannot be attributed to a different checkout SHA",()=>{
 const sha="a".repeat(40);
 assert.equal(verifyCheckoutHead(sha,()=>sha),sha);
 assert.throws(()=>verifyCheckoutHead(sha,()=> "b".repeat(40)),/checkout_does_not_match_attested_head/);
 assert.throws(()=>verifyCheckoutHead("bad",()=>sha),/checkout_does_not_match_attested_head/);
});

test("live Luna evidence rejects fallback even when a real turn produced tokens",()=>{
 assert.equal(requireObservedProductionModel("gpt-6-luna","gpt-6-luna"),"gpt-6-luna");
 for(const actual of ["gpt-4.1-mini","gpt-6-luna-v2","unknown",null]){
  assert.throws(()=>requireObservedProductionModel(actual,"gpt-6-luna"),
   /live_capture:unexpected_runtime_model/);
 }
 assert.throws(()=>requireObservedProductionModel("gpt-6-luna",null),
  /live_capture:unexpected_runtime_model/);
});

test("a live report cannot pass by ignoring failed cases",()=>{
 assert.equal(allCasesAccountedFor(80,80,[]),true);
 assert.equal(allCasesAccountedFor(80,79,[]),false);
 assert.equal(allCasesAccountedFor(80,80,[{id:"case_17",code:"live_capture:timeout"}]),false);
 assert.equal(failureCode(new Error("live_capture:agent_timeout")),"live_capture:agent_timeout");
 assert.equal(failureCode(new Error("token=secret owner@example.com")),"live_capture:unclassified_failure");
});

test("live audit reads existing ai_usage_events, never a nonexistent agent log",async()=>{
 const businessId="cafe_test",ownerMessageId="owner_message_test";
 const id="11111111-1111-4111-8111-111111111111";
 const valid={id,provider:"openai",model:"gpt-6-luna",input_tokens:140,model_call_count:1};
 const db=record=>({query:async(sql,args)=>{
  assert.match(sql,/from public\.ai_usage_events/);
  assert.doesNotMatch(sql,/agent_turn_logs/);
  assert.deepEqual(args,[businessId,ownerMessageId]);
  return {rows:record?[record]:[]};
 }});
 assert.deepEqual(await readPersistedModelUsage(db(valid),businessId,ownerMessageId,{attempts:1}),valid);
 for(const bad of [{provider:"fake"},{model:"unknown"},{input_tokens:0},{model_call_count:0},{id:"bad"}])
  await assert.rejects(readPersistedModelUsage(db({...valid,...bad}),businessId,ownerMessageId,{attempts:1}),/live_capture:model_usage_unverified/);
 await assert.rejects(readPersistedModelUsage(db(null),businessId,ownerMessageId,{attempts:1}),/live_capture:model_usage_not_persisted/);
});
test("an ack, incomplete turn or failed model response cannot count as done",()=>{
 const good={error:null,done:{endReason:"complete",reply:{
  id:"11111111-1111-4111-8111-111111111111",blocks:[{type:"text",text:"Confirmed"}]}}};
 assert.deepEqual(requireCompletedTurn(good),good.done);
 for(const item of [{error:"timeout",done:good.done},{done:null},
  {done:{...good.done,endReason:"timeout"}},
  {done:{...good.done,reply:{...good.done.reply,id:null}}},
  {done:{...good.done,reply:{...good.done.reply,blocks:[]}}}])
  assert.throws(()=>requireCompletedTurn(item),/live_capture:agent_turn_not_complete/);
});

test("only independently labeled purchase lines are approved through owner authority",()=>{
 const p={id:"11111111-1111-4111-8111-111111111111",revision:1,status:"draft",
  capability_id:"maya.inventory_purchase.v1",created_at:"2026-11-13T10:00:00Z",
  canonical_effect_payload:{name:"Whole milk",quantity:1,unit:"gal",costCents:500,
   ingredientId:"44444444-4444-4444-8444-444444444444",receiptLineIndex:0}};
 const observation=[p];
 const expected={outcome:"updated",authorization:"owner_click",
  approvals:[{lineId:"proposal_0",sourceLineId:"line_1"}],
  writes:[{sourceLineId:"line_1",ingredient:"whole_milk",unit:"ml_x10000",delta:37854118,costCents:500}],
  extracted:[{lineId:"proposal_0",name:"Whole milk",quantity:1,unit:"gal",
   costCents:500,confidence:"verified"}]};
 assert.deepEqual(planOwnerApprovals({expected},[],observation),[
  {proposalId:p.id,revision:1}]);
 assert.deepEqual(planOwnerApprovals({expected:{...expected,authorization:"direct_authorized",approvals:[]}},[],observation),[]);
 const fails=[
  {...expected,writes:[{...expected.writes[0],ingredient:"espresso_beans"}]},
  {...expected,writes:[{...expected.writes[0],costCents:999}]},
  {...expected,extracted:[{...expected.extracted[0],quantity:2}]},
  {...expected,approvals:[{lineId:"proposal_1",sourceLineId:"line_1"}]}
 ];
 for(const candidate of fails)assert.throws(
  ()=>planOwnerApprovals({expected:candidate},[],observation),/live_capture:/);
 assert.throws(()=>planOwnerApprovals({expected},[],[{...p,status:"committed"}]),
  /unreviewed_proposal_cannot_be_approved/);
 assert.throws(()=>planOwnerApprovals({expected},[],[{...p,revision:0}]),
  /unreviewed_proposal_cannot_be_approved/);
 assert.throws(()=>planOwnerApprovals({expected},[],[{
  ...p,canonical_effect_payload:{...p.canonical_effect_payload,ingredientId:null}}]),
  /live_capture:/);
});
