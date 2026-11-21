import test from "node:test";
import assert from "node:assert/strict";
import {matchedCount,assertU3ObservedEvidence} from "./u3-canonical-research.mjs";

test("U3 independent count check rejects substring, wrong count and absent source",()=>{
 assert.equal(matchedCount("17 orders and 61 order lines",17),true);
 assert.equal(matchedCount("117 orders",17),false);
 assert.equal(matchedCount("unknown",0),false);
 assert.equal(matchedCount("1,017 orders",1017),true);
});
test("U3 live oracle requires observed Luna, registered research and no effects",()=>{
 const ok={model:"gpt-6-luna",tools:["describe_data","query_data"],
  text:"17 orders, 61 order lines, recorded sales 1,234.56",orders:17,lines:61,cents:123456,proposals:0};
 assert.doesNotThrow(()=>assertU3ObservedEvidence(ok));
 assert.throws(()=>assertU3ObservedEvidence({...ok,tools:["get_sales"]}),/registered_research_tool_not_used/);
 assert.throws(()=>assertU3ObservedEvidence({...ok,model:"mock"}),/unexpected_runtime_model/);
 assert.throws(()=>assertU3ObservedEvidence({...ok,cents:12345}),/independent_source_result_mismatch/);
 assert.throws(()=>assertU3ObservedEvidence({...ok,proposals:1}),/unapproved_effect_created/);
});
