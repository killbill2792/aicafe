import {beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
const mocks=vi.hoisted(()=>{
  const message={id:"owner-msg",role:"owner",contentType:"text",
    threadId:"a1989b23-e2b8-412e-a08f-46fb2726eedc",text:"Are there any staff problems now?",
    clientMessageId:"5106fd7b-1d80-486c-a026-dc1f39911f4c"};
  return {message,run:vi.fn(),propose:vi.fn(),persist:vi.fn(),getExisting:vi.fn(),
    getThread:vi.fn(async()=>({title:"Conversation"})),
    addOwner:vi.fn(async()=>message),listMessages:vi.fn()};
});
vi.mock("@/lib/ai/conversations/enabled.server",()=>({isSupervisorChatConfigured:()=>true}));
vi.mock("@/lib/ai/conversations/auth.server",()=>({
  ConversationApiError:class ConversationApiError extends Error {
    constructor(public status:number,public code:string){super(code);}
  },
  authenticatedConversationContext:async()=>({
    scope:{businessId:"cafe-1",ownerUserId:"owner-1"},
    service:{getThread:mocks.getThread,addOwnerMessage:mocks.addOwner,listMessages:mocks.listMessages},
  }),
}));
vi.mock("@/lib/ai/cafeTools.server",()=>({
  createAuthenticatedCafeTools:async()=>({getTeamTasks:vi.fn()}),
  readSupervisorCafeIdentity:async()=>({asOf:"2026-10-10",timezone:"America/Los_Angeles",cafeName:"Sample"}),
}));
vi.mock("@/lib/ai/conversations/runSupervisorTurn.server",()=>({runSupervisorTurn:mocks.run}));
vi.mock("@/lib/metrics/p1Readers.server",()=>({authorizedOwnerP1:vi.fn(async()=>({
  identity:{businessId:"cafe-1",currency:"USD"}}))}));
vi.mock("@/lib/data/getMenuControlCenter",()=>({getMenuControlCenter:vi.fn(async()=>[
 {id:"c580ce3e-c67d-4abc-a7b8-90795a4bf265",name:"Iced Latte",baseName:"Iced Latte",
  active:true,priceCents:525},
 {id:"76798875-d648-42b4-95e9-b0f0b2a04def",name:"Mocha",baseName:"Mocha",
  active:true,priceCents:560},
])}));

vi.mock("@/lib/ai/supervisor/loop/priceExperiment.server",()=>({priceExperimentCapabilityId:"alex.drink_price_experiment.v1",supervisorLoopRegistry:{
  list:()=>["alex.drink_price_experiment.v1"],
  get:()=>({proposalDescription:"Prepare inert owner trial draft",parseEffect:(raw:unknown)=>raw,
    proposalInputJsonSchema:{type:"object",properties:{productId:{type:"string"},increaseCents:{type:"integer"}}}}),
}}));
vi.mock("@/lib/ai/supervisor/loop/engine",()=>({
  proposeLoop:mocks.propose,
}));
vi.mock("@/lib/ai/conversations/usage.server",()=>({
  labelSupervisorThread:async()=>{},recordSupervisorUsage:async()=>{},
}));
vi.mock("@/lib/ai/policies/auth.server",()=>({
  authenticatedTeamRulesService:async()=>({listActiveRules:async()=>[]}),
}));
vi.mock("@/lib/ai/conversations/replyWriter.server",()=>({
  getExistingSupervisorReply:mocks.getExisting,persistGroundedSupervisorReply:mocks.persist,
}));
import {POST} from "./route";
import {SupervisorStageError} from "@/lib/ai/conversations/diagnostics.server";
import {SupervisorReplyValidationError} from "@/lib/ai/conversations/replyValidation";
const request=(text:string)=>new Request("https://cafe.test/api/ai/threads/"+mocks.message.threadId+"/messages",{
  method:"POST",headers:{origin:"https://cafe.test","content-type":"application/json"},
  body:JSON.stringify({clientMessageId:mocks.message.clientMessageId,text,locale:"en"}),
});
const ctx={params:Promise.resolve({threadId:mocks.message.threadId})};
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.getExisting.mockResolvedValue(null);
  mocks.propose.mockResolvedValue(null);
  mocks.listMessages.mockResolvedValue({items:[
    {id:"m1",role:"owner",text:"What are my best sellers?",blocks:null},
    {id:"m2",role:"supervisor",text:null,blocks:[
      {type:"count",label:"Latte units sold",value:40},
      {type:"count",label:"Mocha units sold",value:20}]},
    mocks.message,
  ]});
  mocks.run.mockResolvedValue({reply:{intent:"staff",status:"verified",evidence:[],
    blocks:[{type:"text",text:"No staff issue records verified"}]},usage:{
      model:"gpt-6-luna",inputTokens:200,outputTokens:50,modelCallCount:2,toolCallCount:1,
    }});
  mocks.persist.mockImplementation(async(_scope,_message,reply)=>({
    ...mocks.message,id:"reply-1",role:"supervisor",blocks:reply.blocks,
  }));
});
describe("POST uses the single bounded semantic Supervisor path",()=>{
  it("routes staff or any other wording through the model and both sides of history",async()=>{
    const response=await POST(request(mocks.message.text),ctx);
    expect(response.status).toBe(201);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const input=mocks.run.mock.calls[0][0];
    expect(input.text).toBe(mocks.message.text);
    expect(input.history).toEqual(expect.arrayContaining([
      {role:"owner",text:"What are my best sellers?"},
      expect.objectContaining({role:"supervisor",text:expect.stringContaining("Mocha units sold: 20")}),
    ]));
    expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
  it("offers a registered inert proposal to the existing semantic model path without regex pre-routing",async()=>{
    const response=await POST(request("Let's test a 10-cent increase on the latte"),ctx);
    expect(response.status).toBe(201);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    const input=mocks.run.mock.calls[0][0];
    expect(input.inertProposal.tools).toContainEqual(expect.objectContaining({
      name:"alex_drink_price_experiment_v1",
      description:expect.stringContaining("inert"),
    }));
    expect(mocks.propose).not.toHaveBeenCalled();
  });
  it.each([
    ["Let's test a 10-cent increase on the latte","en"],
    ["Probemos subir el latte 10 centavos","es"],
    ["لنجرّب زيادة سعر latte ١٠ سنتات","ar"],
  ] as const)(
    "uses the registered model tool to CREATE a draft for %s (%s), never approving or committing",
    async(text,locale)=>{
      mocks.propose.mockResolvedValueOnce({id:"a1520966-6bca-4774-9f58-31376314845f",
        canonicalEffectPayload:{productId:"c580ce3e-c67d-4abc-a7b8-90795a4bf265",
          productName:"Iced Latte",newPriceCents:535}});
      mocks.run.mockImplementationOnce(async(input)=>{
        // Simulate the actual semantic model selecting an advertised native
        // function-call tool. This test fails on commit 8260923: no tool was
        // registered with the investigation path or handled by its callback.
        const tool=input.inertProposal.tools.find((t:{name:string})=>t.name===
          "alex_drink_price_experiment_v1");
        expect(tool).toEqual(expect.objectContaining({
          description:expect.stringContaining("inert"),
          parameters:expect.objectContaining({type:"object"}),
        }));
        const drafted=await input.inertProposal.create(tool.name,{
          productId:"c580ce3e-c67d-4abc-a7b8-90795a4bf265",
          productReference:"latte",ownerProductQuote:"latte",variantStatus:"unique",
          amountMode:"increase",increaseCents:10,targetPriceCents:null,
          ownerAmountQuote:locale==="en"?"10-cent increase":locale==="es"?"10 centavos":"١٠ سنتات",
          amountStatus:"unique",
        });
        expect(drafted?.id).toBe("a1520966-6bca-4774-9f58-31376314845f");
        return {reply:{intent:"menu_pricing",status:"estimated",
          evidence:[{source:"pricing_engine",
            identifier:"supervisor-proposal:"+drafted.id,asOf:"2026-10-10"}],
          blocks:[{type:"text",text:drafted.text}]},
          usage:{model:"test",inputTokens:8,outputTokens:10,modelCallCount:1,toolCallCount:1}};
      });
      const req=new Request("https://cafe.test/api/ai/threads/"+mocks.message.threadId+"/messages",{
        method:"POST",headers:{origin:"https://cafe.test","content-type":"application/json"},
        body:JSON.stringify({clientMessageId:mocks.message.clientMessageId,text,locale}),
      });
      const reply=await POST(req,ctx);
      expect(reply.status).toBe(201);
      expect(mocks.run).toHaveBeenCalledTimes(1);
      expect(mocks.propose).toHaveBeenCalledTimes(1);
      expect(mocks.propose).toHaveBeenCalledWith(expect.objectContaining({
        businessId:"cafe-1",ownerUserId:"owner-1",locale}),
        expect.anything(),expect.anything(),"alex.drink_price_experiment.v1",
        {productId:"c580ce3e-c67d-4abc-a7b8-90795a4bf265",increaseCents:10},
        mocks.message.clientMessageId);
      expect(mocks.persist).toHaveBeenCalledWith(expect.anything(),expect.anything(),
        expect.objectContaining({status:"estimated",blocks:[
          expect.objectContaining({text:expect.stringContaining(locale==="en"?"Nothing has changed":
            locale==="es"?"No se ha cambiado":"لم يتغير")})]}));
    },
  );
  it("refuses a model-selected proposal when two owner amounts are ambiguous",async()=>{
    mocks.run.mockImplementationOnce(async(input)=>{
      const selected=input.inertProposal.tools[0];
      const denied=await input.inertProposal.create(selected.name,{
        productId:"c580ce3e-c67d-4abc-a7b8-90795a4bf265",increaseCents:10});
      expect(denied).toBeNull();
      return {reply:{intent:"unknown",status:"partial",evidence:[],
        blocks:[{type:"text",text:"Please clarify the increase."}]},
        usage:{model:"test",inputTokens:8,outputTokens:10,modelCallCount:1,toolCallCount:0}};
    });
    const response=await POST(request("Test a 10 cent or 20 cent increase on the latte"),ctx);
    expect(response.status).toBe(201);
    expect(mocks.propose).not.toHaveBeenCalled();
  });
  it("replays the existing reply without another provider call or write",async()=>{
    mocks.getExisting.mockResolvedValue({id:"existing-reply"});
    const response=await POST(request(mocks.message.text),ctx);
    expect(response.status).toBe(200);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("categorizes persistence failures in safe server diagnostics and preserves generic owner error",async()=>{
    const reported:string[]=[];
    const logger=vi.spyOn(console,"info").mockImplementation(message=>reported.push(String(message)));
    try {
      mocks.persist.mockRejectedValueOnce(new Error("DO NOT LOG private SQL, wages, or bill figures"));
      const response=await POST(request(mocks.message.text),ctx);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({error:"conversation_request_failed"});
      const rows=reported.map(value=>JSON.parse(value));
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({stage:"owner_message_persisted"}),
        expect.objectContaining({stage:"reply_persistence",category:"reply_persistence"}),
      ]));
      expect(new Set(rows.map(x=>x.requestId)).size).toBe(1);
      expect(reported.join(" ")).not.toContain("DO NOT LOG");
      expect(reported.join(" ")).not.toContain(mocks.message.text);
    }finally{logger.mockRestore();}
  });
  it.each([
    ["provider_http","provider_response"],
    ["provider_timeout","provider_request"],
    ["provider_incomplete","provider_response"],
    ["invalid_tool_call","tool_call_parse"],
    ["tool_execution","tool_execution"],
    ["final_output_validation","final_response_validation"],
  ] as const)("keeps owner error generic for internal %s",async(category,stage)=>{
    const reported:string[]=[];
    const logger=vi.spyOn(console,"info").mockImplementation(message=>reported.push(String(message)));
    try{
      mocks.run.mockRejectedValueOnce(new SupervisorStageError(category,stage,{round:1,attempt:1}));
      const response=await POST(request(mocks.message.text),ctx);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({error:"conversation_request_failed"});
      expect(reported.join(" ")).toContain('"category":"'+category+'"');
      expect(reported.join(" ")).not.toContain(mocks.message.text);
      expect(mocks.persist).not.toHaveBeenCalled();
    }finally{logger.mockRestore();}
  });
  it("preserves Retry state on provider errors instead of claiming missing café data",async()=>{
    mocks.run.mockRejectedValue(new Error("Supervisor provider unavailable"));
    const response=await POST(request(mocks.message.text),ctx);
    expect(response.status).toBe(500);
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("degrades a validateGroundedReply gate failure into a graceful insufficient_evidence reply instead of a raw error, while logging it loudly behind the debug flag",async()=>{
    const reported:string[]=[];
    const logger=vi.spyOn(console,"info").mockImplementation(message=>reported.push(String(message)));
    const previousFlag=process.env.SUPERVISOR_DEBUG_RAW_LOGGING;
    process.env.SUPERVISOR_DEBUG_RAW_LOGGING="true";
    try{
      const buggyReply={intent:"profitability" as const,status:"verified" as const,evidence:[],
        blocks:[{type:"text" as const,text:"Unverified financial claim"}]};
      mocks.persist
        .mockRejectedValueOnce(new SupervisorReplyValidationError("missing_evidence",
          "Supervisor response requires trusted evidence",buggyReply))
        .mockImplementationOnce(async(_scope,_message,reply)=>({
          ...mocks.message,id:"fallback-reply",role:"supervisor",blocks:reply.blocks,
          grounding:{status:reply.status},
        }));
      const response=await POST(request(mocks.message.text),ctx);
      expect(response.status).toBe(201);
      const body=await response.json();
      expect(body.reply.id).toBe("fallback-reply");
      expect(mocks.persist).toHaveBeenCalledTimes(2);
      const fallbackReply=mocks.persist.mock.calls[1][2];
      expect(fallbackReply.status).toBe("insufficient_evidence");
      expect(fallbackReply.blocks.every((b:{type:string})=>b.type==="warning"||b.type==="text")).toBe(true);
      const rows=reported.map(value=>JSON.parse(value));
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({stage:"reply_validation",category:"reply_validation",
          replyValidationReason:"missing_evidence"}),
      ]));
      const debugRows=rows.filter(r=>r.event==="supervisor_turn_debug_test_only");
      const failurePoint=debugRows.find(r=>r.point==="reply_validation_failed");
      expect(failurePoint).toMatchObject({reason:"missing_evidence"});
      expect(failurePoint.reply.blocks[0].text).toBe("Unverified financial claim");
      // The first (rejected) attempt failed VALIDATION, not persistence -- that
      // is already captured by the reply_validation_failed point above, so the
      // only persistence_result point here is the successful fallback write.
      expect(debugRows.filter(r=>r.point==="persistence_result")).toEqual([
        expect.objectContaining({ok:true,fallback:true}),
      ]);
      expect(debugRows.some(r=>r.point==="turn_received")).toBe(true);
      expect(debugRows.some(r=>r.point==="http_response_sent"&&r.httpStatus===201&&
        r.replyStatus==="insufficient_evidence")).toBe(true);
      // Every debug point for this turn shares one correlation id across the
      // full lifecycle, not just the investigation rounds.
      expect(new Set(debugRows.map(r=>r.requestId)).size).toBe(1);
    }finally{
      logger.mockRestore();
      if(previousFlag===undefined)delete process.env.SUPERVISOR_DEBUG_RAW_LOGGING;
      else process.env.SUPERVISOR_DEBUG_RAW_LOGGING=previousFlag;
    }
  });
});
