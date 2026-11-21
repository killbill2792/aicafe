import test from "node:test";
import assert from "node:assert/strict";
import {matchedMoney,assertNativeReceipts} from "./u2-model-execution.mjs";
test("U2 independent money oracle rejects a substring or a different amount",()=>{
 assert.equal(matchedMoney("USD 1,245.50",124550),true);
 assert.equal(matchedMoney("USD 11,245.50",124550),false);
 assert.equal(matchedMoney("unknown",-1),false);
});
test("U2 native-discovery oracle requires actual complete Luna receipts",()=>{
 const row={model:"gpt-6-luna",outcome:"completed",nativeSearch:true,inputTokens:100,outputTokens:20,discoveryCalls:1};
 assert.doesNotThrow(()=>assertNativeReceipts([row,{...row,discoveryCalls:0}]));
 assert.throws(()=>assertNativeReceipts([row]),/receipts_missing/);
 assert.throws(()=>assertNativeReceipts([{...row,discoveryCalls:0},{...row,discoveryCalls:0}]),/discovery_not_observed/);
 assert.throws(()=>assertNativeReceipts([row,{...row,model:"other"}]),/receipts_missing/);
});
