import test from "node:test";
import assert from "node:assert/strict";
import {toScaled,stockRows,expectedAfter,ledgerWrites,proposalLines} from "./runner.mjs";

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
 const gold=[{lineId:"human_1"}];
 assert.deepEqual(proposalLines([],one,gold),[{
  lineId:"human_1",name:"Whole milk",quantity:2,unit:"gal",
  costCents:1198,confidence:"verified"
 }]);
 assert.deepEqual(proposalLines(one,one,gold),[]);
 const unmapped=proposalLines([],one,[]);
 assert.equal(unmapped[0].lineId,"unexpected_0");
});
