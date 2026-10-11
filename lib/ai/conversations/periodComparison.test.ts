import {describe,expect,it} from "vitest";
import {compareCompleteValues} from "./periodComparison";
const q={level:"high" as const,missingInputs:[],estimatedInputs:[],staleInputs:[]};
const known=(n:number)=>({available:true as const,value:n,quality:q});
describe("Server-only deterministic period comparisons",()=>{
  it("computes sign, safe integer difference and percentage without the model",()=>{
    expect(compareCompleteValues(known(87000),known(100000))).toMatchObject({
      available:true,value:{current:87000,previous:100000,difference:-13000,
        direction:"down",changePercent:-13}});
    expect(compareCompleteValues(known(120000),known(100000))).toMatchObject({
      available:true,value:{difference:20000,direction:"up",changePercent:20}});
    expect(compareCompleteValues(known(500),known(0))).toMatchObject({
      available:true,value:{difference:500,changePercent:null}});
  });
  it("never reports a definitive change from missing or partial covered days",()=>{
    const partial={available:true as const,value:7000,quality:{...q,missingInputs:["salesCoverage:7/10"]}};
    expect(compareCompleteValues(partial,known(10000))).toMatchObject({available:false});
    expect(compareCompleteValues({available:false as const,value:null,quality:q},known(10000))).toMatchObject({available:false});
  });
});
