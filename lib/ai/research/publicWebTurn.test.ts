import { describe, expect, it, vi } from "vitest";
import { createWebSearch } from "@/lib/ai/agent/webSearch.server";
import type { AgentProvider } from "@/lib/ai/agent/loop.server";
import { runResearchTurn } from "./turn.server";

const supplierQuestion = "Can you find me a bagel wholesaler? I am trying to find lox bagel!";
const scope = { db: {} as never, businessId: "test-cafe", ownerUserId: "test-owner" };
const done = { type: "response.completed", response: { usage: { input_tokens: 2, output_tokens: 3 } } };
const call = (id:string, query:string) => ({ type:"response.output_item.done", item:{
  type:"function_call",name:"search_web",call_id:id,arguments:JSON.stringify({query}),
} });
const sourceUrl = "https://research.example/public-source";
const providerBody = (status:"completed"|"incomplete"="completed", text="Source findings", count=1) => ({
  id: "resp_fixture", model: "gpt-6-luna", status,
  ...(status==="incomplete"?{incomplete_details:{reason:"max_output_tokens"}}:{}),
  usage: { input_tokens: 20, output_tokens: 11, output_tokens_details:{reasoning_tokens: 9} },
  output: [
    { type: "web_search_call", status: "completed", action: { type: "search" } },
    { type: "web_search_call", status: "completed", action: { type: "open_page" } },
    { type: "message", content: [{ type: "output_text", text, annotations: Array.from({length:count}, (_,i)=>({
      type: "url_citation", url:i===0?sourceUrl:sourceUrl+"/"+i,title:"Reference "+i,
    })) }] },
  ],
});
const answer = (delta:string) => ({type:"response.output_text.delta",delta});
function scripted(rounds:unknown[][]) {
  const requests:Record<string,unknown>[]=[];
  const provider:AgentProvider=async function*(params){
    requests.push(params);
    for(const event of rounds[requests.length-1]??[])yield event as {type:string};
  };
  return {provider,requests};
}
const functionOutput=(request:Record<string,unknown>,id:string)=>{
  const input=request.input as {type?:string;call_id?:string;output?:string}[];
  return JSON.parse(input.find(item=>item.type==="function_call_output"&&item.call_id===id)?.output??"null");
};

describe("shared native public research in the deployed Supervisor turn",()=>{
  it("delegates the original supplier objective and accounts for the native hosted call",async()=>{
    const fetch=vi.fn<typeof globalThis.fetch>(async()=>Response.json(providerBody("completed","Grounded details. ".repeat(140),7)));
    const lookup=createWebSearch({fetch,apiKey:"fixture",model:"gpt-6-luna"});
    const {provider,requests}=scripted([[call("first",supplierQuestion),done],[answer("See [public source]("+sourceUrl+")."),done]]);
    const result=await runResearchTurn({ownerText:supplierQuestion,cafeContext:"Private context",scope,provider,
      webSearch:(query,signal,budget)=>lookup(query,budget,signal)});
    const payload=JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(payload).toMatchObject({input:supplierQuestion,tools:[{type:"web_search"}],tool_choice:"required",store:false});
    expect(payload).not.toHaveProperty("max_output_tokens");
    expect(JSON.stringify(payload)).not.toContain("Private context");
    expect(fetch).toHaveBeenCalledTimes(1);
    const tool=functionOutput(requests[1],"first");
    expect(tool.result.answer.length).toBeGreaterThan(1500);
    expect(tool.result.sources).toHaveLength(7);
    expect(tool.result.answer).toContain("[1](<"+sourceUrl+">)");
    expect(result.text).toContain("[public source]("+sourceUrl+")");
    expect(result.usage).toMatchObject({modelCalls:3,inputTokens:24,outputTokens:17,
      requests:[{kind:"responses"},{kind:"hosted_web",outcome:"completed"},{kind:"responses"}]});
  });

  it("recovers a transport timeout and labels a genuinely cited incomplete answer",async()=>{
    const question="Compare public transit connections and bicycle access to two museums.";
    const fetch=vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new DOMException("Timed out","TimeoutError"))
      .mockResolvedValueOnce(Response.json(providerBody("incomplete")));
    const lookup=createWebSearch({fetch,apiKey:"fixture"});
    const {provider,requests}=scripted([[call("first",question),done],[call("refine",question),done],
      [answer("The [source]("+sourceUrl+") confirms one part. The other detail is unverified."),done]]);
    const result=await runResearchTurn({ownerText:question,cafeContext:"Fixture",scope,provider,
      webSearch:(query,signal,budget)=>lookup(query,budget,signal)});
    expect(functionOutput(requests[1],"first")).toEqual({ok:false,error:"timeout"});
    expect(functionOutput(requests[2],"refine")).toMatchObject({ok:true,result:{status:"partial",reason:"outputLimit",sources:[{url:sourceUrl}]}});
    expect(result.usage.requests?.filter(row=>row.kind==="hosted_web").map(row=>row.outcome)).toEqual(["failed","incomplete"]);
  });

  it("rejects known private values and propagates permission denial as a failed tool",async()=>{
    const question="What are the public guidelines for early voting?";
    const lookup=vi.fn(async()=>({available:false,reason:"permissionDenied"}));
    const {provider,requests}=scripted([[call("private",question+" Confidential cafe detail"),done],
      [call("public",question),done],[answer("Web permission is unavailable."),done]]);
    await runResearchTurn({ownerText:question,cafeContext:"Fixture",scope,provider,privateWebValues:["CONFIDENTIAL CAFE DETAIL"],webSearch:lookup});
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(functionOutput(requests[1],"private")).toMatchObject({ok:false,error:expect.stringContaining("private café data")});
    expect(functionOutput(requests[2],"public")).toEqual({ok:false,error:"permissionDenied"});
  });
});
