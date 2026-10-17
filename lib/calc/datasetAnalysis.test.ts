import {describe,it,expect} from "vitest";
import {analyzeDataset,type AuthorizedDataset,type DatasetPlan} from "./datasetAnalysis";
const dataset:AuthorizedDataset={rows:[{amountCents:125,category:"supplies",status:"actual"},
  {amountCents:390,category:"supplies",status:"actual"},{amountCents:900,category:"rent",status:"estimated"}],
  fields:[{key:"amountCents",unit:"USD_cents",numeric:true},{key:"category",unit:null,numeric:false},
    {key:"status",unit:null,numeric:false}],missingInputs:[],estimatedInputs:["rent"],staleInputs:[]};
const plan:DatasetPlan={purpose:"dataset_analysis",readId:"r1",operation:"sum",field:"amountCents",groupBy:null,filters:[]};
describe("generic bounded authorized dataset calculations",()=>{
  it("composes filters/grouping on source-defined fields without question-specific math",()=>{
    expect(analyzeDataset({...plan,filters:[{field:"status",operator:"eq",value:"actual"}]},dataset))
      .toEqual({ok:true,groups:[{group:null,value:515}],unit:"USD_cents"});
    expect(analyzeDataset({...plan,groupBy:"category"},dataset))
      .toEqual({ok:true,groups:[{group:"supplies",value:515},{group:"rent",value:900}],unit:"USD_cents"});
    expect(analyzeDataset({...plan,operation:"count",field:null},dataset)).toMatchObject({groups:[{value:3}],unit:"scalar"});
  });
  it("rejects undeclared numeric fields, raw code and unknown null values",()=>{
    expect(analyzeDataset({...plan,field:"constructor"},dataset)).toMatchObject({ok:false});
    expect(analyzeDataset({...plan,field:"process.env"},dataset)).toMatchObject({ok:false});
    expect(analyzeDataset(plan,{...dataset,rows:[{amountCents:null}]})).toMatchObject({ok:false});
    expect(analyzeDataset(plan,{...dataset,rows:[{amountCents:1.5}]})).toMatchObject({ok:false});
  });
  it("rejects overflow and excess groups, preserves verified empty counts",()=>{
    expect(analyzeDataset(plan,{...dataset,rows:[{amountCents:Number.MAX_SAFE_INTEGER}]})).toMatchObject({ok:false});
    expect(analyzeDataset({...plan,groupBy:"category"},{...dataset,rows:Array.from({length:21},(_,i)=>({category:String(i),amountCents:1}))}))
      .toMatchObject({ok:false,reason:"dataset_group_limit"});
    expect(analyzeDataset({...plan,operation:"count",field:null},{...dataset,rows:[]})).toMatchObject({ok:true,groups:[{value:0}]});
  });
});
