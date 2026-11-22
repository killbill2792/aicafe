import assert from "node:assert/strict";
import test from "node:test";
import {fieldState,newFieldReport,observeOrder,observePayment,publicFieldReport}
  from "./diagnostic-toast-standard-customer-probe-core.mjs";

test("preserves absent / explicit null / empty / populated as separate evidence",()=>{
 const obj={customer:null,tabName:" ",customerNotes:"Alice"};
 assert.equal(fieldState(obj,"customer"),"null");
 assert.equal(fieldState(obj,"customer.guid"),"absent");
 assert.equal(fieldState(obj,"tabName"),"empty");
 assert.equal(fieldState(obj,"customerNotes"),"populated");
 assert.equal(fieldState(obj,"customer.phone"),"absent");
});
test("counts real provider-shape fields but never emits their values",()=>{
 const name="DANGEROUS_NAME_DO_NOT_PRINT";
 const digits="4111111111111111";
 const secret="SECRET_NEVER_PRINT";
 const raw={
  guid:"00000000-0000-4000-8000-000000000001",
  source:"In Store",
  checks:[{
   guid:"00000000-0000-4000-8000-000000000002",
   tabName:name,customer:null,appliedLoyaltyInfo:null,
   payments:[{guid:"00000000-0000-4000-8000-000000000003",
    type:"CREDIT",cardEntryMode:"EMV_CHIP_SIGN",
    cardholderName:name,cardDetails:{cardholderName:name},
    first6Digits:"411111",pan:digits,password:secret}]
  }]
 };
 const report=newFieldReport();
 observeOrder(report,raw);
 assert.deepEqual(report.objectCounts,{order:1,check:1,payment:1});
 assert.equal(report.fields.check["customer"].null,1);
 assert.equal(report.fields.check["tabName"].populated,1);
 assert.equal(report.fields.payment["cardholderName"].populated,1);
 assert.equal(report.fields.payment["cardDetails.cardholderName"].populated,1);
 assert.equal(report.fields.payment["cardPaymentId"].absent,1);
 assert.equal(report.fields.payment["first6Digits"].populated,1);
 const displayed=JSON.stringify(publicFieldReport(report));
 assert.equal(displayed.includes(name),false);
 assert.equal(displayed.includes(digits),false);
 assert.equal(displayed.includes(secret),false);
 assert.equal(displayed.includes("payment.pan"),false);
 assert.equal(displayed.includes("password"),false);
});
test("direct payments can report nested fields not present on the order",()=>{
 const report=newFieldReport();
 observePayment(report,{cardholder:{firstName:"First",lastName:"Last"},customer:null,
  paymentAccountReference:null,cardPaymentId:"card-id"});
 assert.equal(report.objectCounts.payment,1);
 assert.equal(report.fields.payment["cardholder.firstName"].populated,1);
 assert.equal(report.fields.payment["customer"].null,1);
 assert.equal(report.fields.payment["paymentAccountReference"].null,1);
 assert.equal(report.fields.payment["cardPaymentId"].populated,1);
});
test("provider schema key scan is bounded and cannot become a payload dump",()=>{
 const report=newFieldReport();
 const arbitrary={customer:{"__proto__":"secret",name:"private",password:"abc"},
  extra:Array.from({length:2000},(_,i)=>({customerName:"secret "+i}))};
 observeOrder(report,arbitrary);
 const displayed=JSON.stringify(publicFieldReport(report));
 assert.ok(displayed.length<25000);
 assert.equal(displayed.includes("private"),false);
 assert.equal(displayed.includes("secret 1"),false);
 assert.equal(displayed.includes("password"),false);
});
