import {beforeEach,describe,expect,it,vi} from "vitest";
import {createWebSearch,extractWebSearchAnswer} from "../webSearch.server";
import {agentToolDefinitions,executeAgentTool,type AgentToolContext} from "./index";

const input={asOf:"2026-10-30",timezone:"America/Chicago",locale:"en"} as AgentToolContext;
const completed=(body:unknown)=>new Response(JSON.stringify(body),{status:200});
const message=(text:string,annotations:unknown[]=[])=>
  ({status:"completed",output:[{type:"web_search_call",status:"completed"},
    {type:"message",content:[{type:"output_text",text,annotations}]}]});
const cited={type:"url_citation",title:"Official parade route",url:"https://city.example.org/parade"};

describe("general web_search",()=>{
  beforeEach(()=>vi.restoreAllMocks());

  it("registers one strict query-only read tool without café credentials or location inputs",()=>{
    const def=agentToolDefinitions.find(t=>t.name==="web_search");
    expect(def).toMatchObject({strict:true,parameters:{additionalProperties:false,required:["query"]}});
    expect(Object.keys(def?.parameters.properties??{})).toEqual(["query"]);
  });

  it("reads the real Responses web-search shape and retains only safe source links",async()=>{
    const body=message("The parade runs on Main Street.",[cited,
      {type:"url_citation",title:"Duplicate",url:"https://city.example.org/parade"},
      {type:"url_citation",title:"Bad URL",url:"javascript:alert(1)"}]);
    expect(extractWebSearchAnswer(body)).toEqual({answer:"The parade runs on Main Street.",
      sources:[{title:"Official parade route",url:"https://city.example.org/parade"}]});
    const fetch=vi.fn(async(_url:string|URL|Request,_init?:RequestInit)=>completed(body));
    const search=createWebSearch({fetch,apiKey:"test-key",model:"test-model"});
    const ctx={...input,webSearch:search};
    const result=await executeAgentTool("web_search",{query:"Where is the parade route?"},ctx);
    expect(result).toMatchObject({source:"web_search",period:null,missing:[],
      answer:"The parade runs on Main Street.",sources:[{url:"https://city.example.org/parade"}]});
    const payload=JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(payload).toMatchObject({store:false,tools:[{type:"web_search"}],model:"test-model"});
    expect(payload.input).toContain("Where is the parade route?");
    expect(payload).not.toHaveProperty("business_id");
    expect(payload.max_output_tokens).toBeLessThanOrEqual(1600);
  });

  it("reserves each paid lookup before sending and returns actual provider token counts",async()=>{
    const payload={...message("The street is closed.",[cited]),
      usage:{input_tokens:31,output_tokens:42,input_tokens_details:{cached_tokens:10}}};
    const fetch=vi.fn(async()=>completed(payload));
    const reserveModelCall=vi.fn(()=>true),recordUsage=vi.fn();
    const search=createWebSearch({fetch,apiKey:"test-key"});
    expect(await search("Street closures?",{reserveModelCall,recordUsage})).toMatchObject({available:true});
    expect(reserveModelCall).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith({inputTokens:31,cachedTokens:10,outputTokens:42});
    const refuse=vi.fn(()=>false);
    expect(await search("Another search?",{reserveModelCall:refuse,recordUsage}))
      .toEqual({available:false,reason:"budget"});
    expect(fetch).toHaveBeenCalledTimes(1);
    const unreadable=createWebSearch({fetch:vi.fn(async()=>completed({
      status:"incomplete",output:[],usage:{input_tokens:7,output_tokens:1200},
    })),apiKey:"test-key"});
    expect(await unreadable("Incomplete?",{reserveModelCall,recordUsage}))
      .toEqual({available:false,reason:"unreadable"});
    expect(recordUsage).toHaveBeenLastCalledWith({inputTokens:7,cachedTokens:0,outputTokens:1200});
  });

  it("rejects model-supplied café scopes, empty queries and oversized queries",async()=>{
    const webSearch=vi.fn();
    const ctx={...input,webSearch};
    await expect(executeAgentTool("web_search",{query:"weather",businessId:"someone-else"},ctx)).rejects.toThrow();
    await expect(executeAgentTool("web_search",{query:"  "},ctx)).rejects.toThrow();
    await expect(executeAgentTool("web_search",{query:"x".repeat(251)},ctx)).rejects.toThrow();
    expect(webSearch).not.toHaveBeenCalled();
  });

  it("treats incomplete and reasoning-only answers as failure rather than invented sources",async()=>{
    for(const body of [
      {status:"incomplete",incomplete_details:{reason:"max_output_tokens"},output:[message("maybe").output[1]]},
      {status:"completed",output:[{type:"reasoning",summary:[]},{type:"web_search_call",status:"completed"}]},
      {status:"completed",output:[{type:"message",content:[]}]},
    ]){
      expect(extractWebSearchAnswer(body)).toBeNull();
    }
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    const search=createWebSearch({fetch:vi.fn(async()=>completed({status:"incomplete",output:[]})),
      apiKey:"test-key"});
    expect(await search("What changed today?")).toEqual({available:false,reason:"unreadable"});
    expect(log.mock.calls.flat().join(" ")).not.toContain("What changed today?");
  });

  it("handles HTTP errors and timeout without leaking query text or response bodies",async()=>{
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    const fetch=vi.fn(async()=>new Response("PRIVATE SERVER BODY",{status:500}));
    expect(await createWebSearch({fetch,apiKey:"test-key"})("route by Main St"))
      .toEqual({available:false,reason:"providerFailed"});
    const timeout=vi.fn(async()=>{throw Object.assign(new Error("private"),{name:"TimeoutError"});});
    expect(await createWebSearch({fetch:timeout,apiKey:"test-key"})("route by Main St"))
      .toEqual({available:false,reason:"timeout"});
    const logs=JSON.stringify(log.mock.calls);
    expect(logs).not.toContain("Main St");
    expect(logs).not.toContain("PRIVATE");
    expect(logs).not.toContain("private");
  });

  it("does not pay for web search when the key or authorized search port is unavailable",async()=>{
    const fetch=vi.fn();
    const search=createWebSearch({fetch,apiKey:""});
    expect(await search("What is the weather?")).toEqual({available:false,reason:"notConfigured"});
    expect(fetch).not.toHaveBeenCalled();
    expect(await executeAgentTool("web_search",{query:"What is the weather?"},input))
      .toMatchObject({notCovered:["webSearchUnavailable"],sources:[]});
  });
});
