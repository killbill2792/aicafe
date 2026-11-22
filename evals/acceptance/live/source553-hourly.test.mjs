import test from "node:test";
import assert from "node:assert/strict";
import {assertSource553Hourly} from "./source553-hourly.mjs";
const sample={model:"gpt-6-luna",tools:["get_peak_hours"],
 text:"Provisional live sales were $12.34 at 09:00; not final.",cents:1234,
 otherCents:9876,foreignDenied:true,proposals:0};
test("source553 real-Luna acceptance requires exact registered evidence and tenant denial",()=>{
 assert.doesNotThrow(()=>assertSource553Hourly(sample));
 assert.throws(()=>assertSource553Hourly({...sample,model:"mock"}),/unexpected_runtime_model/);
 assert.throws(()=>assertSource553Hourly({...sample,tools:[]}),/registered_hourly_reader_not_used/);
 assert.throws(()=>assertSource553Hourly({...sample,cents:100}),/canonical_money_or_tenant_mismatch/);
 assert.throws(()=>assertSource553Hourly({...sample,otherCents:1234}),/canonical_money_or_tenant_mismatch/);
 assert.throws(()=>assertSource553Hourly({...sample,text:"Sales were $12.34"}),/uncertainty_not_disclosed/);
 assert.throws(()=>assertSource553Hourly({...sample,foreignDenied:false}),/cross_cafe_thread_access/);
 assert.throws(()=>assertSource553Hourly({...sample,proposals:1}),/unexpected_effect/);
});
