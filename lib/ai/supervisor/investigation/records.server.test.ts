import {describe,it,expect} from "vitest";
import {buildRecordsRegistration,RECORDS_ID,recordCollections} from "./records.server";
import {createP2Registry,type TrustedReadScope} from "../p2/registry";
import type {Observation} from "./evidence";
const scope:TrustedReadScope={businessId:"cafe",identity:{businessId:"cafe",asOf:"2026-10-19",timezone:"UTC",currency:"USD"},
  role:"owner",shadowEnabled:true,tools:{} as TrustedReadScope["tools"]};
const rows=Array.from({length:30},(_,i)=>({name:"Worker "+i,active:i%2===0,availability:[{startLocal:"09:00",endLocal:"12:00"}]}));
const source:Observation={id:"r1",capabilityId:"authorized.roster",input:{},result:{value:{employees:rows},quality:{missingInputs:[],estimatedInputs:[],staleInputs:[]}},
  reference:{source:"cafe_state",identifier:"trusted-source",asOf:scope.identity.asOf},display:{}};
const registry=createP2Registry([buildRecordsRegistration(()=>[source],scope.businessId)]);
const args={purpose:"authorized_record_projection",readId:"r1",path:"value.employees",offset:0,limit:5,
  filters:[{field:"active",operator:"eq",value:true}]};
describe("authorized generic record inspection",()=>{
  it("exposes only known collections, filters and pages the original source without mutation",async()=>{
    expect(recordCollections(source.result.value)).toContain("value.employees.0.availability");
    const before=JSON.stringify(source);
    expect(await registry.invoke(scope,RECORDS_ID,args)).toMatchObject({status:"partial",hasMore:true,
      value:rows.filter(r=>r.active).slice(0,5)});
    expect(JSON.stringify(source)).toBe(before);
  });
  it("rejects unknown paths, prototype traversal, extra model data and guessed sources",async()=>{
    for(const input of [{...args,path:"value.employees.__proto__"},{...args,path:"process.env"},
      {...args,readId:"r9"},{...args,records:[{private:true}]},
      {...args,filters:[{field:"salary_secret",operator:"eq",value:true}]}]){
      expect(await registry.invoke(scope,RECORDS_ID,input)).toMatchObject({status:"unavailable"});
    }
  });
  it("does not reinterpret a different tenant scope as authority over the turn's records",async()=>{
    expect(await registry.invoke({...scope,businessId:"other",identity:{...scope.identity,businessId:"other"}},RECORDS_ID,args))
      .toMatchObject({status:"unavailable",reason:"unauthorized"});
  });
});
