import test from "node:test";
import assert from "node:assert/strict";
import {verifyTask14bToolTrace,verifyTask14bScope} from "./task14b.mjs";

test("Task14B real-agent trace requires a source read BEFORE owner proposal",()=>{
 const proof=verifyTask14bToolTrace([
   "inspect_supplier_purchase","propose_supplier_purchase_order"]);
 assert.equal(proof.toolCalls,2);
 for(const calls of [
   ["propose_supplier_purchase_order"],
   ["propose_supplier_purchase_order","inspect_supplier_purchase"],
   ["get_supplier_purchase_orders","propose_supplier_purchase_order"],
   ["inspect_supplier_purchase"],
   ["inspect_supplier_purchase","invented_approval"]
 ])assert.throws(()=>verifyTask14bToolTrace(calls),/task14b_live:required_multistep_tool_missing/);
});

test("Task14B owner correction must independently read the saved original ID",()=>{
 assert.deepEqual(verifyTask14bToolTrace([
  "get_supplier_purchase_orders","inspect_supplier_purchase","propose_supplier_purchase_order"
 ],{correction:true}).required,[
  "get_supplier_purchase_orders","inspect_supplier_purchase","propose_supplier_purchase_order"
 ]);
 assert.throws(()=>verifyTask14bToolTrace([
  "inspect_supplier_purchase","propose_supplier_purchase_order"
 ],{correction:true}),/required_multistep_tool_missing_get_supplier_purchase_orders/);
});

test("Task14B paid acceptance cannot claim another café or thread's proposal",()=>{
 const scope={businessId:"cafe-a",ownerUserId:"owner-a",threadId:"thread-a"};
 const data={business_id:"cafe-a",owner_user_id:"owner-a",
  thread_id:"thread-a",capability_id:"maya.supplier_purchase_order.v1"};
 assert.equal(verifyTask14bScope(data,scope),data);
 for(const [key,value] of Object.entries({
  business_id:"cafe-b",owner_user_id:"owner-b",
  thread_id:"thread-b",capability_id:"maya.inventory_purchase.v1"
 }))assert.throws(()=>verifyTask14bScope({...data,[key]:value},scope),
  /task14b_live:unverified_saved_owner_scope/);
});
