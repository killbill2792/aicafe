import { describe, expect, it, vi } from "vitest";
import { createWebSearch } from "@/lib/ai/agent/webSearch.server";
import type { AgentProvider } from "@/lib/ai/agent/loop.server";
import { withDurableProviderTurn } from "@/lib/ai/supervisor/runs/provider-reservation.server";
import { configuredSupervisorModel } from "@/lib/ai/conversations/modelConfig";
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

  it("withholds private spans from the current message, matched answers and earlier conversation",async()=>{
    const history=[{role:"assistant" as const,content:"Our employee Marisol Quinn handles delivery at 123 Orchard Road."}];
    const ownerText=supplierQuestion+" My number is (415) 555-0142.";
    const matchedOwnerAnswers=[{question:"Who is the private contact?",answer:"Carmen Solano",answerId:"matched",
      questionId:"clarification"}];
    const attempted=["4155550142","Marisol Quinn","123 Orchard Road","Carmen Solano"];
    const {provider,requests}=scripted([
      [...attempted.map((value,i)=>call("private"+i,supplierQuestion+" "+value)),call("public",supplierQuestion),done],
      [answer("Here is the public evidence."),done],
    ]);
    const lookup=vi.fn(async()=>({available:true}));
    await runResearchTurn({ownerText,history,matchedOwnerAnswers,cafeContext:"Fixture",scope,provider,webSearch:lookup});
    expect(lookup).toHaveBeenCalledExactlyOnceWith(supplierQuestion,expect.any(AbortSignal),expect.anything(),undefined);
    attempted.forEach((_,i)=>expect(functionOutput(requests[1],"private"+i)).toMatchObject({ok:false}));
  });

  it("continues the same paid Responses request after the Supervisor worker yields", async () => {
    let state:unknown, controller:AbortSignal|undefined;
    let revision=1, interrupted=false;
    const reserve=vi.fn<(name:string,params:Record<string,unknown>)=>Promise<{data:null;error:null}>>(
      async()=>({data:null,error:null}));
    const attempts=vi.fn(() => ({
      select:()=>({eq:function eq(){return {eq,maybeSingle:async()=>({data:{model:"gpt-6-luna",status:"attempted"},error:null})};}}),
    }));
    const binding={...scope,db:{rpc:reserve,from:attempts},ownerMessageId:"message",threadId:"thread",runId:"run",
      jobId:"job",claimToken:"lease",ownerDailyCap:null,unrestrictedResearch:true,authorize:async()=>{},
      budget:{maxModelCalls:10,maxToolCalls:10,maxOutputTokens:10000,maxInputTokens:10000,maxElapsedMs:2000}};
    const settled={...done,response:{...done.response,model:configuredSupervisorModel()}};
    const {provider,requests}=scripted([
      [call("first",supplierQuestion),settled],
      [answer("See the [public source]("+sourceUrl+")."),settled],
    ]);
    const transport=vi.fn<typeof fetch>(async (_url,init)=>{
      if(init?.method==="POST")return Response.json({id:"resp_fixture",status:"queued"});
      return Response.json(providerBody());
    });
    const lookup=createWebSearch({fetch:transport,apiKey:"fixture",model:"gpt-6-luna"});
    const base:Parameters<typeof runResearchTurn>[0]={
      ownerText:supplierQuestion,cafeContext:"Fixture",scope,provider,
      continuation:{load:async()=>state,save:async next=>{state=structuredClone(next);}},
      webSearch:(query,signal,budget,continuation)=>{
        controller=signal;
        if(!continuation||!budget)throw Error("missing hosted continuation");
        return lookup(query,{...budget,continuation:{...continuation,authorize:async()=>revision,
          save:async next=>{
            await continuation.save(next);
            if(next.responseId&&!interrupted){interrupted=true;await new Promise(resolve=>setTimeout(resolve,180));}
          },
        }},signal);
      },
    };
    const yielded=await withDurableProviderTurn(binding,()=>runResearchTurn({...base,executionDeadline:Date.now()+150}));
    expect(yielded.endReason).toBe("timeout");
    expect(controller?.aborted).toBe(true);
    expect(state).toMatchObject({webCheckpoint:{revision:1,responseId:"resp_fixture",attemptId:expect.any(String)}});
    const submitted=JSON.parse(String(transport.mock.calls[0][1]?.body));
    expect(submitted).toMatchObject({input:supplierQuestion,background:true,store:false});
    const beforeResume=structuredClone(state);
    const result=await withDurableProviderTurn(binding,()=>runResearchTurn(base));
    expect(result.endReason).toBe("complete");
    expect(result.text).toContain(sourceUrl);
    expect(transport.mock.calls.map(([url,init])=>[String(url),init?.method??"GET"])).toEqual([
      ["https://api.openai.com/v1/responses","POST"],["https://api.openai.com/v1/responses/resp_fixture","GET"],
    ]);
    const {attemptId}=(beforeResume as {webCheckpoint:{attemptId:string}}).webCheckpoint;
    expect(reserve.mock.calls.filter(([name,p])=>name==="supervisor_complete_investigation_model_call"&&p.p_attempt_id===attemptId)).toHaveLength(1);
    expect(functionOutput(requests[1],"first").result.sources).toEqual([{url:sourceUrl,title:"Reference 0"}]);
    state=beforeResume;
    revision=2;
    const denied=scripted([[answer("Public access changed."),settled]]);
    await withDurableProviderTurn(binding,()=>runResearchTurn({...base,provider:denied.provider}));
    expect(functionOutput(denied.requests[0],"first")).toEqual({ok:false,error:"permissionDenied"});
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
