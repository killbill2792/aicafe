import {describe,it,expect} from "vitest";
import {modelTokenUsage,estimateModelCallCostMicros,aggregateModelCallCosts} from "./supervisorTokenCost";
describe("OpenAI per-call token cost accounting",()=>{
  it("prices cached input only once and includes reasoning tokens inside output",()=>{
    const usage=modelTokenUsage({input_tokens:10000,output_tokens:2000,
      input_tokens_details:{cached_tokens:6000},output_tokens_details:{reasoning_tokens:1200}});
    expect(usage).toEqual({inputTokens:10000,cachedInputTokens:6000,uncachedInputTokens:4000,
      outputTokens:2000,reasoningOutputTokens:1200});
    expect(estimateModelCallCostMicros(usage!,{input:"0.10",cachedInput:"0.01",output:"0.50"}))
      .toBe(1460);
  });
  it("does not misprice missing cached-input rates or missing usage",()=>{
    expect(estimateModelCallCostMicros({
      inputTokens:20,cachedInputTokens:10,uncachedInputTokens:10,outputTokens:4,
      reasoningOutputTokens:0,
    },{input:"0.10",cachedInput:undefined,output:"0.50"})).toBeNull();
    expect(modelTokenUsage({input_tokens:4,output_tokens:1,
      input_tokens_details:{cached_tokens:10}})).toBeNull();
  });
  it("aggregates mixed-model calls and flags unknown cost instead of calling it zero",()=>{
    const totals=aggregateModelCallCosts([
      {model:"gpt-6-luna",requestName:"investigation",inputTokens:10,cachedInputTokens:2,
        outputTokens:4,reasoningOutputTokens:1,estimatedCostMicros:3},
      {model:"unknown",requestName:"review",inputTokens:9,cachedInputTokens:0,
        outputTokens:6,reasoningOutputTokens:0,estimatedCostMicros:null},
    ]);
    expect(totals.modelCalls).toBe(2);expect(totals.inputTokens).toBe(19);
    expect(totals.estimatedCostMicros).toBeNull();expect(totals.unpricedCalls).toBe(1);
    expect(totals.byModel["gpt-6-luna"].estimatedCostMicros).toBe(3);
  });
});
