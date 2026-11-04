import {describe,expect,it} from "vitest";
import {requirePositivePriceIncrease} from "./priceExperiment";

describe("price experiment proposal increase validation",()=>{
  it.each([null,0,-1,-10])("rejects %s with a distinct reason code",(increase)=>{
    expect(()=>requirePositivePriceIncrease(increase)).toThrow("price_increase_must_be_positive");
    try{requirePositivePriceIncrease(increase);}catch(error){
      expect(error).toMatchObject({code:"validation"});
    }
  });
  it("accepts a positive integer cent increase",()=>{
    expect(()=>requirePositivePriceIncrease(10)).not.toThrow();
  });
});
