import {beforeAll,afterAll,beforeEach,describe,it,expect,vi} from "vitest";
vi.mock("server-only",()=>({}));
vi.mock("@/lib/metrics/p1Readers.server",async original=>({...await original<object>(),authorizedOwnerP1:vi.fn(),executeP1Authorized:vi.fn()}));
vi.mock("@/lib/metrics/p1AtomicSourceSnapshot.server",()=>({readAuthorizedAtomicP1SourceSnapshot:vi.fn()}));
vi.mock("@/lib/scheduling/oliviaCapabilities.server",()=>({executeOliviaReadCapability:vi.fn()}));
vi.mock("@/lib/ai/suppliers/research.server",()=>({researchEnabled:vi.fn(()=>false),researchPublicSources:vi.fn()}));
import {authorizedOwnerP1,executeP1Authorized} from "@/lib/metrics/p1Readers.server";
import {readAuthorizedAtomicP1SourceSnapshot} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import {executeOliviaReadCapability} from "@/lib/scheduling/oliviaCapabilities.server";
import {researchEnabled,researchPublicSources} from "@/lib/ai/suppliers/research.server";
import {runSupervisorTurn} from "@/lib/ai/conversations/runSupervisorTurn.server";
import {capabilityToolName,CALCULATE_TOOL_NAME,detectConflictingFacts} from "./runInvestigation.server";
import {validateGroundedReply} from "@/lib/ai/conversations/replyValidation";
import {readers,purposePolicies,type SupportedId} from "@/lib/metrics/p1Catalog";
import type {AtomicP1SourceSnapshot} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import type {BusinessScopedCafeTools} from "@/lib/ai/tools";
import type {InvestigationAnswer} from "./protocol";
import {EXPRESSION_ID} from "../p3/expression";
import {observationDisplay,type Observation} from "./evidence";

const cafe="a0000000-0000-4000-8000-000000000999",product="a0000000-0000-4000-8000-000000000001";
const ingredient="a0000000-0000-4000-8000-000000000100",employee="a0000000-0000-4000-8000-000000000002";
const asOf="2026-10-19",identity={businessId:cafe,cafeName:"Test café",asOf,timezone:"America/Los_Angeles",currency:"USD"};
const snapshot:AtomicP1SourceSnapshot={contract:"p1.authoritative_snapshot.v1",businessId:cafe,revision:"100",timezone:identity.timezone,currency:"USD",
  payroll:{rate:0.12,status:"confirmed",source:"business"},sources:{
    menu:[{id:product,name:"Iced Latte",price_cents:525,is_active:true,category:"ESPRESSO_DRINK"}],
    ingredients:[{id:ingredient,name:"Milk",base_unit:"ml"}],
    ingredientPrices:[{id:"a0000000-0000-4000-8000-000000000200",ingredient_id:ingredient,effective_from:"2026-09-01",cost_per_base_unit_micros:100000,source:"manual"}],
    recipes:[{menu_item_id:product,ingredient_id:ingredient,quantity:200}],
    employees:[{id:employee,display_name:"Sophie",role:"barista",active:true,default_hourly_wage_cents:1800,wage_period:"hour",wage_amount_cents:1800}],
    dailyRollups:[],expenses:[],recurringCosts:[],imports:[]},
  truncated:{menu:false,ingredients:false,ingredientPrices:false,recipes:false,employees:false,dailyRollups:false,expenses:false,recurringCosts:false,imports:false},coverage:"not_proven_by_revision"};
const auth=vi.mocked(authorizedOwnerP1),p1=vi.mocked(executeP1Authorized),atomic=vi.mocked(readAuthorizedAtomicP1SourceSnapshot);
const olivia=vi.mocked(executeOliviaReadCapability);
const base={locale:"en" as const,asOf,timezone:identity.timezone,cafeName:"Test café",tools:{} as BusinessScopedCafeTools,history:[],readRules:async()=>[]};
const q={level:"high",missingInputs:[],estimatedInputs:[],staleInputs:[]};
const period={from:"2026-10-01",to:asOf};
const query=(id:SupportedId,extras:object={})=>({id,version:1,purpose:purposePolicies[id][0],...extras});
const response=(data:unknown)=>new Response(JSON.stringify({status:"completed",usage:{input_tokens:10,output_tokens:10},output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(data)}]}]}));
// Opaque markers; transportFor alone knows how to turn one into a native
// tool-call response or a direct structured-answer response, exactly as
// production distinguishes the two.
const read=(capabilityId:string,args:unknown)=>({__tool:true as const,capabilityId,args});
const calculate=(plan:unknown)=>({__tool:true as const,capabilityId:EXPRESSION_ID,args:plan});
const answer=(paragraphs:InvestigationAnswer["paragraphs"])=>({paragraphs});
function envelope(input:Record<string,unknown>,value:unknown){
  const id=input.id as SupportedId;
  return {id,version:1,query:input,status:"partial",unit:"typed_record",valueKind:"record",value,
    quality:q,completeness:"partial",actuality:"actual",provenance:{canonicalReaderId:readers[id],readerContractVersion:1,
      selectorContractId:id+".selector",selectorContractVersion:1,purpose:input.purpose,asOf,timezone:identity.timezone,sourceRevision:null},
    freshness:{asOf,capturedAt:null,stale:null}};
}
const toolCallResponse=(name:string,args:unknown,callId:string)=>new Response(JSON.stringify({status:"completed",
  usage:{input_tokens:10,output_tokens:10},output:[{type:"function_call",call_id:callId,name,arguments:JSON.stringify(args)}]}));
function transportFor(steps:unknown[],inspect?:(context:Record<string,unknown>,step:number)=>void,privacySafe=true){
  let next=0,callSeq=0;
  return vi.fn(async(_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    if(body.text.format.name==="supervisor_calendar_context_review")return response({verdict:"applies"});
    if(body.text.format.name==="supervisor_public_query_review")return response({safe:privacySafe});
    if(body.text.format.name==="supervisor_investigation_review")return response({supported:true,complete:true,reason:"ok"});
    expect(body.text.format.name).toBe("supervisor_investigation_step");
    inspect?.(JSON.parse(body.input[0].content),next);
    const entry=steps[next++]??answer([{kind:"clarification",text:"Which remaining option should I investigate?",citations:[]}]);
    if(entry&&typeof entry==="object"&&(entry as {__tool?:boolean}).__tool){
      const tool=entry as {capabilityId:string;args:unknown};
      callSeq++;
      const name=tool.capabilityId===EXPRESSION_ID?CALCULATE_TOOL_NAME:capabilityToolName(tool.capabilityId);
      return toolCallResponse(name,tool.args,"call_"+callSeq);
    }
    return response(entry);
  });
}
let key:string|undefined;
beforeAll(()=>{key=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY="mock-key";});
afterAll(()=>{if(key===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=key;});
beforeEach(()=>{
  vi.clearAllMocks();auth.mockResolvedValue({identity,tools:base.tools});atomic.mockResolvedValue({status:"available",snapshot});
  vi.mocked(researchEnabled).mockReturnValue(false);
  p1.mockImplementation(async(_t,_i,raw)=>{
    const input=raw as Record<string,unknown>;
    const values:Record<string,unknown>={
      "menu.catalog":[{id:product,name:"Iced Latte",category:"drink",active:true,priceCents:525,priceStatus:"recorded"}],
      "menu.product_economics":{id:product,name:"Iced Latte",category:"drink",active:true,priceCents:525,prepSeconds:80,
        ingredientsCentsToday:20,hasRecipe:true,costStatus:"READY",quantitySoldLast28Days:10},
      "labor.employee_wages":[{id:employee,name:"Sophie",role:"barista",active:true,defaultHourlyWageCents:1800,
        wagePeriod:"hour",wageAmountCents:1800,wageKnown:true,wageProvenance:"recorded_positive"}],
      "labor.payroll_burden":{rateBasisPoints:1200,status:"confirmed",source:"business"},
      "money.expense_entries":[{id:"a",spentOn:"2026-10-01",categoryCode:"supplies",amountCents:125,status:"actual",source:"manual"},
        {id:"b",spentOn:"2026-10-02",categoryCode:"supplies",amountCents:390,status:"actual",source:"receipt"},
        {id:"c",spentOn:"2026-10-03",categoryCode:"rent",amountCents:900,status:"estimated",source:"manual"}],
    };
    return envelope(input,values[String(input.id)]??null) as Awaited<ReturnType<typeof executeP1Authorized>>;
  });
});

describe("default Supervisor iterative cross-domain intelligence",()=>{
  it.each([[17,35,7409],[19,40,8251],[23,20,10943]])("discovers records and computes unseen price/labor composition (%i items, %i minutes)",async(items,minutes,expected)=>{
    const plan={capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",description:"Conditional incremental contribution, excluding unobserved overhead and demand",
      nodes:[{op:"source",handle:`menu.product_economics:${product}:priceCents`},
        {op:"source",handle:`menu.product_economics:${product}:ingredientsCentsToday`},{op:"subtract"},
        {op:"hypothetical",label:"additional drinks",quotedNumber:String(items),value:items,unit:"item"},{op:"multiply"},
        {op:"source",handle:`labor.employee_wages:${employee}:defaultHourlyWageCents`},
        {op:"hypothetical",label:"additional paid time",quotedNumber:String(minutes),value:minutes,unit:"minute"},{op:"multiply"},
        {op:"source",handle:"labor.payroll_burden:aggregate:rateBasisPoints"},{op:"loaded_labor"},{op:"subtract"}]};
    const transport=transportFor([
      read("p3.menu.catalog.v1",query("menu.catalog")),
      read("p3.menu.product_economics.v1",query("menu.product_economics",{productId:product})),
      read("p3.labor.employee_wages.v1",query("labor.employee_wages")),
      read("p3.labor.payroll_burden.v1",query("labor.payroll_burden")),
      calculate(plan),
      answer([{kind:"evidence",text:"Under your assumptions, the incremental contribution is {{r5:value}}. This excludes other costs and does not predict demand.",citations:["r5"]}]),
    ],(context,step)=>{
      if(step===1)expect(JSON.stringify(context.observations)).toContain(product);
      if(step===5)expect(JSON.stringify(context.observations)).toContain(String(expected));
    });
    const result=await runSupervisorTurn({...base,text:`Would ${items} extra Iced Latte drinks help if Sophie works ${minutes} more minutes?`},transport);
    expect(result.reply.blocks.some(b=>b.type==="text"&&b.text.includes((expected/100).toFixed(2)))).toBe(true);
    expect(result.usage.toolCallCount).toBe(5);expect(result.usage.modelCallCount).toBe(7);
    expect(validateGroundedReply(result.reply)).toEqual(result.reply);
    expect(transport).toHaveBeenCalledTimes(7);
  });

  it("filters and aggregates arbitrary recorded expense fields instead of adding a report for the question",async()=>{
    const transport=transportFor([read("p3.money.expense_entries.v1",query("money.expense_entries",{period})),
      read("p3.platform.dataset.analysis.v1",{purpose:"dataset_analysis",readId:"r1",operation:"sum",field:"amountCents",groupBy:null,
        filters:[{field:"status",operator:"eq",value:"actual"},{field:"categoryCode",operator:"eq",value:"supplies"}]}),
      answer([{kind:"evidence",text:"The recorded actual supply entries total {{r2:value.groups.0.value}} for this period. Estimated entries were excluded.",citations:["r2"]}])]);
    const result=await runSupervisorTurn({...base,text:"For month to date, total the actual supply entries and leave estimated rent out."},transport);
    expect(result.reply.blocks.some(b=>b.type==="text"&&b.text.includes("$5.15"))).toBe(true);
    expect(result.usage.toolCallCount).toBe(2);
  });

  it("carries the scenario through a pronoun-free follow-up and re-reads changed ingredient costs",async()=>{
    const scenario=(quantity:number)=>read("p3.alex.pricing.what_if.v1",{purpose:"pricing_simulate",product:{exactName:"Iced Latte"},
      changes:[{kind:"set_quantity",ingredientName:"Milk",quantity:{value:quantity,unit:"ml"}}]});
    const final=answer([{kind:"evidence",text:"That recipe would change ingredient cost by {{r1:value.0.ingredientCostDeltaCents}} per drink; labor, fees and rent are excluded.",citations:["r1"]}]);
    const first=await runSupervisorTurn({...base,text:"What if Iced Latte uses 300 ml of Milk?"},transportFor([scenario(300),final]));
    expect(JSON.stringify(first.reply.blocks)).toContain("$0.10");
    expect(JSON.stringify(first.reply.investigationMemory)).not.toContain("costPerBaseUnitMicros");
    const changed={...snapshot,revision:"101",sources:{...snapshot.sources,ingredientPrices:snapshot.sources.ingredientPrices.map(p=>({...p,cost_per_base_unit_micros:200000}))}};
    atomic.mockResolvedValue({status:"available",snapshot:changed});
    const second=await runSupervisorTurn({...base,text:"Use 400 ml instead.",investigationMemory:first.reply.investigationMemory},
      transportFor([scenario(400),final],(context,step)=>{if(step===0){
        expect(JSON.stringify(context.rememberedSelectors)).toContain("Iced Latte");
        expect(context.ownerStatements).toContain("What if Iced Latte uses 300 ml of Milk?");
      }}));
    expect(JSON.stringify(second.reply.blocks)).toContain("$0.40");
  });

  it.each(["en","es","ar"] as const)("supports general workflow advice without a café-data interrogation (%s)",async(locale)=>{
    const text={en:"Prepare the handoff before the rush and review bottlenecks with the team.",
      es:"Prepara el relevo antes de la hora punta y revisa los cuellos de botella con el equipo.",
      ar:"جهّز تسليم العمل قبل الازدحام وراجع نقاط التأخير مع الفريق."}[locale];
    const result=await runSupervisorTurn({...base,locale,text:"How could we improve our service workflow?"},transportFor([answer([{kind:"advice",text,citations:[]}])]));
    expect(result.reply.blocks).toContainEqual({type:"text",text});
    expect(result.usage.toolCallCount).toBe(0);
    expect(validateGroundedReply(result.reply)).toEqual(result.reply);
  });

  it("reports unconnected competitor research specifically and still offers useful analysis guidance",async()=>{
    const transport=transportFor([read("p3.public.research.v1",{purpose:"public_market_research",query:"nearby cafe menu prices",ownerResearchClause:"nearby cafe menu prices"}),
      answer([{kind:"advice",text:"Live competitor research is not connected here. Compare equivalent sizes and locations before changing prices; I can analyze a menu you provide.",citations:[]}])],
      (context,step)=>{if(step===1)expect(JSON.stringify(context.observations)).toContain("research_not_connected");});
    const result=await runSupervisorTurn({...base,text:"Compare nearby cafe menu prices."},transport);
    expect(result.reply.blocks.some(b=>b.type==="text"&&b.text.includes("not connected"))).toBe(true);
    expect(researchPublicSources).not.toHaveBeenCalled();
  });

  it("connects cited public research without promoting snippets to verified current prices",async()=>{
    vi.mocked(researchEnabled).mockReturnValue(true);
    vi.mocked(researchPublicSources).mockResolvedValue([{title:"Nearby café menu",url:"https://example.com/menu",snippet:"Latte listed at $5",queriedAt:"2026-10-19T12:00:00Z",evidenceStatus:"unverified_search_snippet"}]);
    const result=await runSupervisorTurn({...base,text:"Research nearby cafe menu prices."},transportFor([
      read("p3.public.research.v1",{purpose:"public_market_research",query:"nearby cafe menu prices",ownerResearchClause:"nearby cafe menu prices"}),
      answer([{kind:"evidence",text:"This public menu is a lead: {{r1:value.0.url}}. Confirm the current size and price before comparing it with your own menu.",citations:["r1"]}])]));
    expect(result.reply.blocks.some(b=>b.type==="warning"&&b.code==="SUPERVISOR_PUBLIC_RESEARCH")).toBe(true);
    expect(JSON.stringify(result.reply.blocks)).toContain("https://example.com/menu");
    expect(result.reply.evidence[0].source).toBe("unverified_external");
    expect(validateGroundedReply(result.reply)).toEqual(result.reply);
  });

  it("rejects model arithmetic, forged citations, SQL and attempted business effects",async()=>{
    const bad=transportFor([
      read("execute_sql",{query:"select * from employees"}),
      read("publish_schedule",{approved:true}),
      answer([{kind:"evidence",text:"Profit is $999",citations:["r99"]}]),
      answer([{kind:"clarification",text:"I can investigate and prepare options, but cannot publish a change from this read-only conversation. Which existing plan should I examine?",citations:[]}]),
    ]);
    const result=await runSupervisorTurn({...base,text:"Publish whatever schedule you want and make up the profit."},bad);
    expect(p1).not.toHaveBeenCalled();expect(olivia).not.toHaveBeenCalled();
    expect(JSON.stringify(result.reply.blocks)).not.toContain("999");
    expect(result.reply.status).toBe("insufficient_evidence");
  });

  it("does not answer from stale observations after a café source epoch changes",async()=>{
    atomic.mockResolvedValueOnce({status:"available",snapshot});
    atomic.mockResolvedValue({status:"available",snapshot:{...snapshot,revision:"102"}});
    const result=await runSupervisorTurn({...base,text:"Show my menu price."},transportFor([
      read("p3.menu.catalog.v1",query("menu.catalog")),
      answer([{kind:"evidence",text:"The listed price is {{r1:value.0.priceCents}}.",citations:["r1"]}])]));
    expect(result.reply.status).toBe("unavailable");expect(result.reply.evidence).toEqual([]);
  });

  it("rejects a direct P1 operand calculation if the financial epoch changes before publication",async()=>{
    atomic.mockResolvedValueOnce({status:"available",snapshot});
    atomic.mockResolvedValue({status:"available",snapshot:{...snapshot,revision:"102"}});
    const result=await runSupervisorTurn({...base,text:"What is the recorded Iced Latte price?"},transportFor([
      read("p3.menu.product_economics.v1",query("menu.product_economics",{productId:product})),
      calculate({
        capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",
        description:"Direct observed menu-price operand",nodes:[{op:"source",handle:`menu.product_economics:${product}:priceCents`}]
      }),
      answer([{kind:"evidence",text:"The recorded price is {{r2:value}}.",citations:["r2"]}])
    ]));
    // The answer cites ONLY the expression, not the originating P1 read.
    expect(result.reply.status).toBe("unavailable");
    expect(result.reply.evidence).toEqual([]);
    expect(atomic).toHaveBeenCalledTimes(2);
  });

  it("bounds provider failures and does not fabricate a clarification about dates",async()=>{
    const transport=vi.fn(async()=>new Response("down",{status:503}));
    const onUsage=vi.fn();
    await expect(runSupervisorTurn({...base,text:"Why are supplies costing more?",onUsage},transport))
      .rejects.toMatchObject({category:"provider_http",httpStatus:503});
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({modelCallCount:1}));
    expect(transport).toHaveBeenCalledTimes(1);
  });

  const malformed=()=>new Response(JSON.stringify({status:"completed",
    usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[{type:"output_text",text:"not valid json"}]}]}));

  it("retries once when the model's first reply is malformed JSON, then answers normally",async()=>{
    const inner=transportFor([answer([{kind:"advice",text:"Keep prep steady during the rush.",citations:[]}])]);
    let stepAttempts=0;
    const transport=vi.fn(async(url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_step"&&++stepAttempts===1)return malformed();
      return inner(url,init);
    });
    const result=await runSupervisorTurn({...base,text:"How should we handle the morning rush?"},transport);
    expect(result.reply.blocks).toContainEqual({type:"text",text:"Keep prep steady during the rush."});
    // malformed step attempt + successful retry + the answer's independent review call.
    expect(transport).toHaveBeenCalledTimes(3);
    expect(result.usage.modelCallCount).toBe(3);
  });

  it("degrades to an unavailable reply instead of crashing the turn when the model's output never parses",async()=>{
    const transport=vi.fn(async()=>malformed());
    const result=await runSupervisorTurn({...base,text:"How should we handle the morning rush?"},transport);
    expect(result.reply.status).toBe("unavailable");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.usage.modelCallCount).toBe(2);
  });

  it("still propagates a raw transport failure instead of persisting a false unavailable answer",async()=>{
    const transport=vi.fn(async()=>{throw new TypeError("fetch failed: ECONNRESET");});
    const onUsage=vi.fn();
    await expect(runSupervisorTurn({...base,text:"How should we handle the morning rush?",onUsage},transport))
      .rejects.toMatchObject({category:"provider_http"});
    // A genuine network failure must not be retried-and-swallowed like malformed model output.
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("classifies a raw network failure with the provider_error failure category",async()=>{
    const transport=vi.fn(async()=>{throw new TypeError("ECONNRESET");});
    const onDiagnostic=vi.fn();
    await expect(runSupervisorTurn({...base,text:"Help me review the morning rush.",onDiagnostic},transport))
      .rejects.toMatchObject({category:"provider_http"});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      stage:"provider_response",category:"provider_http",failureCategory:"provider_error",
    }));
  });

  it("still propagates a terminal provider failure status instead of persisting a false unavailable answer",async()=>{
    const transport=vi.fn(async()=>new Response(JSON.stringify({status:"failed",
      usage:{input_tokens:5,output_tokens:5},output:[]})));
    await expect(runSupervisorTurn({...base,text:"How should we handle the morning rush?"},transport))
      .rejects.toMatchObject({category:"provider_http"});
    // A terminal "failed"/"cancelled" generation must not be retried-and-swallowed either.
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("reports why an investigation step failed instead of staying silent",async()=>{
    const transport=vi.fn(async()=>malformed());
    const onDiagnostic=vi.fn();
    await runSupervisorTurn({...base,text:"How should we handle the morning rush?",onDiagnostic},transport);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:"provider_response",
      category:"provider_invalid_payload",requestName:"supervisor_investigation_step",attempt:1}));
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:"provider_response",
      category:"provider_invalid_payload",requestName:"supervisor_investigation_step",attempt:2}));
  });
});

describe("reviewer advisory for an already-masked partial",()=>{
  it("does not veto a surviving grounded claim when a separate claim is unresolvable",async()=>{
    let count=0;
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_review")
        return response({supported:false,complete:true,reason:"Some requested evidence is unavailable."});
      const context=JSON.parse(body.input[0].content) as {observations:unknown[]};
      if(context.observations.length===0)
        return toolCallResponse(capabilityToolName("p3.menu.catalog.v1"),query("menu.catalog"),"call_1");
      count++;
      return response(answer([
        {kind:"evidence",text:"The menu lists {{r1:value.0.priceCents}}.",citations:["r1"]},
        {kind:"advice",text:"An unsupported figure is $99999.",citations:[]},
      ]));
    });
    const out=await runSupervisorTurn({...base,text:"What is the price and another unknown fact?"},transport);
    expect(JSON.stringify(out.reply.blocks)).toContain("The menu lists");
    expect(JSON.stringify(out.reply.blocks)).not.toContain("$99999");
    expect(out.reply.status).toBe("partial");
    expect(count).toBeGreaterThan(0);
  });
});
describe("review verdict publication policy",()=>{
  it("keeps a wholly narrative source-grounded paragraph on negative review, without requiring a metric card",async()=>{
    const steps=transportFor([
      read("p3.menu.catalog.v1",query("menu.catalog")),
      answer([
        {kind:"evidence",text:"The catalog lists {{r1:value.0.name}}.",citations:["r1"]},
        {kind:"advice",text:"I have already published the schedule.",citations:[]},
      ]),
    ]);
    const transport=vi.fn(async(url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_review")
        return response({supported:false,complete:false,
          reason:"The schedule-completion statement has no action evidence."});
      return steps(url,init);
    });
    const result=await runSupervisorTurn({...base,text:"Which drink is listed and did you publish shifts?"},transport);
    expect(result.reply.status).toBe("partial");
    expect(result.reply.blocks.some(b=>b.type==="text"&&b.text.includes("The catalog lists Iced Latte"))).toBe(true);
    expect(result.reply.blocks.some(b=>b.type==="metric"||b.type==="percent"||b.type==="task_card")).toBe(false);
    expect(JSON.stringify(result.reply.blocks)).not.toContain("already published");
    expect(JSON.stringify(result.reply.blocks)).toContain("schedule-completion");
  });
  it("keeps only server-grounded partial facts if a reviewer objects to another goal",async()=>{
    const steps=transportFor([
      read("p3.menu.catalog.v1",query("menu.catalog")),
      answer([
        {kind:"evidence",text:"The catalog price is {{r1:value.0.priceCents}}.",citations:["r1"]},
        {kind:"advice",text:"I have already published the schedule.",citations:[]},
      ]),
    ]);
    const transport=vi.fn(async(url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_review")
        return response({supported:false,complete:false,
          reason:"The schedule-completion statement has no action evidence."});
      return steps(url,init);
    });
    const result=await runSupervisorTurn({...base,
      text:"What is the latte price, and did you publish the shifts?"},transport);
    expect(result.reply.status).toBe("partial");
    expect(result.reply.blocks.some(b=>b.type==="metric"&&b.valueCents===525)).toBe(true);
    expect(JSON.stringify(result.reply.blocks)).not.toContain("already published");
  });
  it("publishes a supported but incomplete answer as a partial reply",async()=>{
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_review")
        return response({supported:true,complete:false,
          reason:"Other parts of the owner request remain unanswered."});
      return response(answer([{kind:"advice",
        text:"Compare the verified inputs before making changes.",citations:[]}]));
    });
    const result=await runSupervisorTurn({...base,text:"Help review my business decisions."},transport);
    expect(result.reply.status).toBe("partial");
    expect(JSON.stringify(result.reply.blocks)).toContain("Compare the verified inputs");
    expect(JSON.stringify(result.reply.blocks)).toContain("Other parts of the owner request remain unanswered.");
    expect(result.reply.status).not.toBe("unavailable");
  });
  it("returns an honest reply for complete-only verdict without publishing unsupported claims",async()=>{
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_review")
        return response({supported:false,complete:true,
          reason:"The model asserted a completed action without any tool evidence."});
      return response(answer([{kind:"advice",text:"I have published everyone's shifts.",
        citations:[]}]));
    });
    const result=await runSupervisorTurn({...base,text:"Have you published the staff schedule?"},transport);
    expect(result.reply.status).toBe("insufficient_evidence");
    expect(JSON.stringify(result.reply.blocks)).not.toContain("I have published");
    expect(result.reply.blocks.some(b=>b.type==="warning")).toBe(true);
  });
});

describe("direct-answer investigation rounds report why they were rejected",()=>{
  it("logs answerRejectedReason render_failed when the proposed answer cites an unknown observation",async()=>{
    const transport=transportFor([
      answer([{kind:"evidence",text:"The price is {{r1:value.priceCents}}.",citations:["r1"]}]),
    ]);
    const onDiagnostic=vi.fn();
    await runSupervisorTurn({...base,text:"What is the price of the Iced Latte?",onDiagnostic},transport);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:"investigation_round",
      agent:"supervisor",answerRejectedReason:"render_failed"}));
  });
  it("logs answerRejectedReason review_failed when the independent review rejects a well-formed answer, and carries the reviewer's own reason into the NEXT round's retry feedback (§6)",async()=>{
    // Before the reviewer's reason existed, every retry after a review
    // rejection carried the same generic, unspecific line regardless of
    // WHAT the reviewer actually found -- this is the exact gap that let two
    // real production turns exhaust with nothing to show and no way to tell
    // why from the logs (see the supervisor_investigation_review writeup).
    const reviewReason="Advice paragraph has no supporting tool evidence.";
    let stepCalls=0;
    const feedbackSeen:unknown[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_review")
        return response({supported:false,complete:false,reason:reviewReason});
      expect(body.text.format.name).toBe("supervisor_investigation_step");
      stepCalls++;
      if(stepCalls===2)feedbackSeen.push(JSON.parse(body.input[0].content).feedback);
      return response(answer([{kind:"advice",text:"Consider reviewing pricing periodically.",citations:[]}]));
    });
    const onDiagnostic=vi.fn();
    await runSupervisorTurn({...base,text:"Any pricing advice?",onDiagnostic},transport);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:"investigation_round",
      agent:"supervisor",answerRejectedReason:"review_failed"}));
    expect(feedbackSeen[0]).toContain(reviewReason);
  });
  it("rescues a genuine answer as unverified, instead of discarding it, when it only fails our display-token formatting",async()=>{
    // A malformed token (bracket syntax, not the strict {{rN:path}} grammar)
    // fails the strict renderer but is still fully stripped by the rescue,
    // and the surrounding prose carries no raw digit/currency/URL of its
    // own -- the one shape of render_failed this safety net can ever cover.
    const badAnswer=answer([{kind:"evidence",
      text:"The listed price is {{r1:value[0].priceCents}} today.",citations:["r1"]}]);
    const transport=transportFor([
      read("p3.menu.catalog.v1",query("menu.catalog")),
      badAnswer,badAnswer,badAnswer,badAnswer,badAnswer,badAnswer,
    ]);
    const onDiagnostic=vi.fn();
    const result=await runSupervisorTurn({...base,text:"What is the price of the Iced Latte?",onDiagnostic},transport);
    expect(result.reply.status).toBe("insufficient_evidence");
    expect(result.reply.evidence).toEqual([]);
    expect(result.reply.blocks).toContainEqual(expect.objectContaining({type:"warning",code:"SUPERVISOR_UNVERIFIED"}));
    expect(result.reply.blocks).toContainEqual({type:"text",
      text:"The listed price is [unchecked value] today."});
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      stage:"investigation_exhausted",rescuedUnverified:true}));
  });
  it("never rescues a render-failed claim whose citation is real but the claim itself was rejected by the rescue's own review",async()=>{
    // Unlike the earlier review_failed test, this answer fails the strict
    // renderer first (a malformed token), so it is the rescue path's own
    // independent review -- not the primary one -- that must catch an
    // unsupported claim dressed up with a real citation. No raw digit of
    // its own, so renderUnverifiedAnswer itself would otherwise accept it.
    const falseClaim=answer([{kind:"evidence",
      text:"I have published shifts already, confirmed by {{r1:value[0].priceCents}}.",citations:["r1"]}]);
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_review")
        return response({supported:false,complete:false,reason:"Claim of already-published shifts has no supporting evidence."});
      expect(body.text.format.name).toBe("supervisor_investigation_step");
      const context=JSON.parse(body.input[0].content) as {observations:unknown[]};
      if(context.observations.length===0)
        return toolCallResponse(capabilityToolName("p3.menu.catalog.v1"),query("menu.catalog"),"call_1");
      return response(falseClaim);
    });
    const onDiagnostic=vi.fn();
    const result=await runSupervisorTurn({...base,text:"Can you inspect scheduling options?",onDiagnostic},transport);
    expect(result.reply.status).toBe("unavailable");
    expect(JSON.stringify(result.reply.blocks)).not.toContain("published");
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      stage:"investigation_exhausted",rescuedUnverified:false}));
  });
  it("preserves the conditional-scenario warning when rescuing a pure hypothetical calculation",async()=>{
    const plan={capabilityId:EXPRESSION_ID,version:1,purpose:"no_external_sources",
      description:"Owner hypothetical extra drinks",
      nodes:[{op:"hypothetical",label:"extra drinks",quotedNumber:"5",value:5,unit:"item"}]};
    const badAnswer=answer([{kind:"evidence",
      text:"Under this scenario, the result is {{r1:value[0]}}.",citations:["r1"]}]);
    const transport=transportFor([
      calculate(plan),
      badAnswer,badAnswer,badAnswer,badAnswer,badAnswer,badAnswer,
    ]);
    const result=await runSupervisorTurn({...base,text:"What if we sold 5 more drinks?"},transport);
    expect(result.reply.status).toBe("insufficient_evidence");
    expect(result.reply.intent).toBe("profitability");
    expect(result.reply.blocks[0]).toMatchObject({type:"warning",code:"P3_CONDITIONAL"});
    expect(result.reply.evidence).toEqual([]);
  });
  it("preserves the public-research caution when rescuing an answer that cites an unverified external source",async()=>{
    vi.mocked(researchEnabled).mockReturnValue(true);
    vi.mocked(researchPublicSources).mockResolvedValue([{title:"Nearby café menu",url:"https://example.com/menu",
      snippet:"Latte listed at $5",queriedAt:"2026-10-19T12:00:00Z",evidenceStatus:"unverified_search_snippet"}]);
    const badAnswer=answer([{kind:"evidence",
      text:"This public menu is a lead: {{r1:value[0].url}}. Confirm it directly.",citations:["r1"]}]);
    const transport=transportFor([
      read("p3.public.research.v1",{purpose:"public_market_research",query:"nearby cafe menu prices",ownerResearchClause:"nearby cafe menu prices"}),
      badAnswer,badAnswer,badAnswer,badAnswer,badAnswer,badAnswer,
    ]);
    const result=await runSupervisorTurn({...base,text:"Research nearby cafe menu prices."},transport);
    expect(result.reply.status).toBe("insufficient_evidence");
    expect(result.reply.blocks.some(b=>b.type==="warning"&&b.code==="SUPERVISOR_UNVERIFIED")).toBe(true);
    expect(result.reply.blocks.some(b=>b.type==="warning"&&b.code==="SUPERVISOR_PUBLIC_RESEARCH")).toBe(true);
  });
  it("never rescues an unverified answer if the active tenant changed mid-turn",async()=>{
    auth.mockResolvedValueOnce({identity,tools:base.tools});
    auth.mockResolvedValue({identity:{...identity,businessId:"another-cafe"},tools:base.tools});
    const badAnswer=answer([{kind:"evidence",
      text:"The listed price is {{r1:value[0].priceCents}} today.",citations:["r1"]}]);
    const transport=transportFor([
      read("p3.menu.catalog.v1",query("menu.catalog")),
      badAnswer,badAnswer,badAnswer,badAnswer,badAnswer,badAnswer,
    ]);
    const onDiagnostic=vi.fn();
    const result=await runSupervisorTurn({...base,text:"What is the price of the Iced Latte?",onDiagnostic},transport);
    expect(result.reply.status).toBe("unavailable");
    expect(result.reply.blocks.some(b=>b.type==="warning"&&b.code==="SUPERVISOR_UNVERIFIED")).toBe(false);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      stage:"investigation_exhausted",rescuedUnverified:false}));
  });
  it("logs answerRejectedReason review_unavailable, not review_failed, when the review never produces a verdict",async()=>{
    const malformed=()=>new Response(JSON.stringify({status:"completed",
      usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[{type:"output_text",text:"not valid json"}]}]}));
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_review")return malformed();
      expect(body.text.format.name).toBe("supervisor_investigation_step");
      return response(answer([{kind:"advice",text:"Consider reviewing pricing periodically.",citations:[]}]));
    });
    const onDiagnostic=vi.fn();
    await runSupervisorTurn({...base,text:"Any pricing advice?",onDiagnostic},transport);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:"investigation_round",
      agent:"supervisor",answerRejectedReason:"review_unavailable"}));
    expect(onDiagnostic).not.toHaveBeenCalledWith(expect.objectContaining({answerRejectedReason:"review_failed"}));
  });
});

it("resolves a scheduling pronoun from owner/thread scenario memory without demanding the name again",async()=>{
  olivia.mockImplementation(async(raw:unknown)=>{
    const request=raw as {capability:string};
    if(request.capability==="olivia.availability.read")return {ok:true,version:1,status:"ok",capability:request.capability,
      source:{owner:"olivia",businessId:cafe,kind:"stored_availability",consistency:"provisional"},employees:[{employeeId:employee,displayName:"Ava",active:true,state:"confirmed",
        recurring:[],exceptions:[],hourLimits:[],preferences:[],qualifications:[],compensation:[]}]} as Awaited<ReturnType<typeof executeOliviaReadCapability>>;
    return {ok:true,version:1,status:"ok",capability:"olivia.schedule.whatIf",source:{owner:"olivia",businessId:cafe,kind:"trusted_preview",consistency:"provisional"},
      baselineScenario:null,alternateScenario:null,baselineStatus:"feasible",baselineProof:"complete_candidate_solution",baselineWarnings:[],
      alternateStatus:"feasible",alternateProof:"complete_candidate_solution",alternateWarnings:[],comparison:{ownerMinutesDifference:0,cashWagesDifferenceCents:200,
        loadedPayrollDifferenceCents:224,gapsDifference:0,completeCoverageBefore:true,completeCoverageAfter:true,changed:true},
      overridesApplied:[],notices:[],employeeNames:{[employee]:"Ava"},locationNames:{},disposition:"hypothetical_simulation_only"} as Awaited<ReturnType<typeof executeOliviaReadCapability>>;
  });
  const cap=(minutes:number)=>read("p3.olivia.schedule.what_if.v1",{purpose:"schedule_what_if",week:asOf,
    overrides:[{kind:"reduce_weekly_minutes",employeeName:"Ava",maxWeeklyMinutes:minutes}]});
  const final=answer([{kind:"evidence",text:"I tested the weekly cap of {{r1:value.0.overridesSummary.0.maxWeeklyMinutes}} minutes. The modeled payroll difference is {{r1:value.0.loadedPayrollDifferenceCents}}; this is a simulation, not a published change.",citations:["r1"]}]);
  const first=await runSupervisorTurn({...base,text:"What if we cap Ava at 120 minutes for the week of 2026-10-19?"},transportFor([cap(120),final]));
  const second=await runSupervisorTurn({...base,text:"Make her cap 90 minutes instead.",investigationMemory:first.reply.investigationMemory},transportFor([{...cap(90),argumentsJson:JSON.stringify({purpose:"schedule_what_if",week:"2026-10-26",
      overrides:[{kind:"reduce_weekly_minutes",employeeName:"Ava",maxWeeklyMinutes:90}]})},cap(90),final]));
  expect(olivia.mock.calls.every(([r])=>typeof r!=="object"||r===null||!("week" in r)||r.week===asOf)).toBe(true);
  // Rejected week mismatch was not executed; only the valid what-if counts.
  expect(second.usage.toolCallCount).toBe(1);
  expect(second.reply.status).toBe("partial");
  expect(JSON.stringify(second.reply.blocks)).toContain("90 minutes");
  expect(olivia).toHaveBeenLastCalledWith(expect.objectContaining({capability:"olivia.schedule.whatIf",
    overrides:[expect.objectContaining({employeeId:employee,maxWeeklyMinutes:90})]}));
});

it("blocks private staff terms from being sent to external research",async()=>{
  vi.mocked(researchEnabled).mockReturnValue(true);
  const result=await runSupervisorTurn({...base,text:"Compare local competitor prices."},transportFor([
    read("p3.labor.employee_wages.v1",query("labor.employee_wages")),
    read("p3.public.research.v1",{purpose:"public_market_research",query:"Sophie wages 1800",ownerResearchClause:"Compare local competitor prices."}),
    answer([{kind:"advice",text:"A public comparison should use equivalent menu sizes and locations; private staff data is not a public research source.",citations:[]}])],
  (context,step)=>{if(step===2)expect(JSON.stringify(context.observations)).toContain("research_query_contains_unapproved_terms");}));
  expect(researchPublicSources).not.toHaveBeenCalled();
  expect(result.reply.status).toBe("partial");
});

it("rejects wrong explicit periods before invoking the source reader",async()=>{
  await runSupervisorTurn({...base,text:"Show recorded expenses for 2026-10-01."},transportFor([
    read("p3.money.expense_entries.v1",query("money.expense_entries",{period:{from:"2026-10-02",to:"2026-10-02"}})),
    answer([{kind:"clarification",text:"I need to verify that date selection before presenting a total.",citations:[]}])]));
  expect(p1).not.toHaveBeenCalled();
});

it("answers and independently reviews a five-operation investigation despite a malformed provider attempt",async()=>{
  const actions=[
    read("p3.menu.catalog.v1",query("menu.catalog")),
    read("p3.menu.product_economics.v1",query("menu.product_economics",{productId:product})),
    read("p3.labor.employee_wages.v1",query("labor.employee_wages")),
    read("p3.labor.payroll_burden.v1",query("labor.payroll_burden")),
    read("p3.money.expense_entries.v1",query("money.expense_entries",{period})),
    answer([{kind:"evidence",text:"The recorded item price is {{r2:value.priceCents}}.",citations:["r2"]}]),
  ];
  const inner=transportFor(actions,(ctx,step)=>{
    if(step===5){
      expect(ctx.finalizeOnly).toBe(true);
      expect(ctx.remainingOperations).toBe(0);
    }
  });
  let stepAttempt=0;
  const transport=vi.fn(async(url:string,init:RequestInit)=>{
    const request=JSON.parse(String(init.body));
    if(request.text.format.name==="supervisor_investigation_step"){
      stepAttempt++;
      if(stepAttempt===1)return new Response(JSON.stringify({status:"completed",
        usage:{input_tokens:5,output_tokens:5},output:[{type:"message",content:[
          {type:"output_text",text:"invalid provider JSON"},
        ]}]}));
      if(stepAttempt===7){
        // The final, finalize-only round offers no tools at all, so a native
        // function call is structurally impossible; the model can only answer
        // directly in the plain paragraphs shape.
        expect(request.tools).toBeUndefined();
        expect(request.text.format.schema.properties.paragraphs).toBeDefined();
      }
    }
    return inner(url,init);
  });
  const result=await runSupervisorTurn({...base,text:"Investigate my Iced Latte's recorded price alongside staffing and expenses."},transport);
  expect(result.reply.status).not.toBe("unavailable");
  expect(JSON.stringify(result.reply.blocks)).toContain("$5.25");
  expect(result.usage.toolCallCount).toBe(5);
  expect(result.usage.modelCallCount).toBe(8);
  expect(transport).toHaveBeenCalledTimes(8);
});

it("does not charge malformed registered inputs that fail inside the registry",async()=>{
  const transport=transportFor([
    read("p3.menu.catalog.v1",{purpose:"not_allowed",ignored:"1"}),
    read("p3.menu.catalog.v1",{purpose:"not_allowed",ignored:"2"}),
    read("p3.menu.catalog.v1",query("menu.catalog")),
    answer([{kind:"evidence",text:"The catalog includes {{r3:value.0.priceCents}} for the recorded latte.",citations:["r3"]}]),
  ]);
  const result=await runSupervisorTurn({...base,text:"What is the recorded latte price?"},transport);
  expect(result.usage.toolCallCount).toBe(1);
  expect(JSON.stringify(result.reply.blocks)).toContain("$5.25");
  expect(p1).toHaveBeenCalledTimes(1);
  expect(result.reply.status).not.toBe("unavailable");
});

it("counts a dispatched domain reader even when its result resembles a registry preflight rejection",async()=>{
  // A domain's response reason is not a reliable dispatch indicator. This P1
  // reader ran even though its *own* unavailable reason is unsupported_period.
  p1.mockImplementationOnce(async()=>{
    const unavailable= {status:"unavailable" as const,value:null,reason:"unsupported_period"};
    return unavailable as Awaited<ReturnType<typeof executeP1Authorized>>;
  });
  const result=await runSupervisorTurn({...base,text:"What is the recorded latte price?"},transportFor([
    read("p3.menu.catalog.v1",query("menu.catalog")),
    answer([{kind:"advice",text:"The recorded item price is unavailable from this source; check the saved menu before quoting a price.",citations:[]}]),
  ]));
  expect(p1).toHaveBeenCalledTimes(1);
  expect(result.usage.toolCallCount).toBe(1);
  expect(result.reply.status).not.toBe("unavailable");
});

it("limits a malformed selection retry to the shared selection window and still finishes an evidenced answer",async()=>{
  const realNow=Date.now();
  let clock=realNow;
  const now=vi.spyOn(Date,"now").mockImplementation(()=>clock);
  try{
    let stepCalls=0;
    const inner=transportFor([
      read("p3.menu.catalog.v1",query("menu.catalog")),
      answer([{kind:"evidence",text:"The recorded latte price is {{r1:value.0.priceCents}}.",citations:["r1"]}]),
    ],(_context,i)=>{
      if(i===0)clock=realNow+25000; // 65s remain: a normal read would fit.
      if(i===1)expect(_context.finalizeOnly).toBe(true);
    });
    const transport=vi.fn(async(url:string,init:RequestInit)=>{
      const request=JSON.parse(String(init.body));
      if(request.text.format.name==="supervisor_investigation_step"&&++stepCalls===2){
        clock=realNow+44000; // Selection's shared deadline; 46s remain for reader+answer+audit.
        return new Response(JSON.stringify({status:"completed",usage:{input_tokens:5,output_tokens:5},
          output:[{type:"message",content:[{type:"output_text",text:"bad JSON"}]}]}));
      }
      return inner(url,init);
    });
    const result=await runSupervisorTurn({...base,text:"What is the recorded latte price?"},transport);
    expect(result.reply.status).not.toBe("unavailable");
    expect(JSON.stringify(result.reply.blocks)).toContain("$5.25");
    expect(result.usage.toolCallCount).toBe(1);
    expect(stepCalls).toBe(3); // Initial read, malformed request, final answer.
    expect(transport).toHaveBeenCalledTimes(4); // Plus independent review.
  }finally{now.mockRestore();}
});

it("reserves extra calendar-gate time when a failed owner correction may require review",async()=>{
  const realNow=Date.now();
  let clock=realNow;
  const now=vi.spyOn(Date,"now").mockImplementation(()=>clock);
  try{
    const memory={version:1 as const,businessId:cafe,ownerStatements:["Show the saved menu."],reads:[]};
    const history=[{role:"owner" as const,text:"Show the saved menu."},
      {role:"owner" as const,text:"Actually use 2026-10-12 instead."}];
    const transport=transportFor([
      read("p3.menu.catalog.v1",query("menu.catalog")),
      answer([{kind:"evidence",text:"The catalog's recorded latte price is {{r1:value.0.priceCents}}.",citations:["r1"]}]),
    ],(context,i)=>{
      if(i===0)clock=realNow+12000; // 78s remain: enough without the extra calendar review, not with it.
      if(i===1){
        expect(context.finalizeOnly).toBe(true);
        expect(context.remainingOperations).toBe(4);
      }
    });
    const result=await runSupervisorTurn({...base,text:"What price was the latte?",
      history,investigationMemory:memory},transport);
    expect(result.usage.toolCallCount).toBe(1);
    expect(result.reply.status).not.toBe("unavailable");
  }finally{now.mockRestore();}
});

it("does not count a byte-heavy but schema-valid expression rejected before simulation dispatch",async()=>{
  // A UTF-8 payload can fit the model's character-counted argumentsJson limit
  // while exceeding the registry's 10 KB input cap. No calculator ran.
  const plan=(suffix:string)=>({capabilityId:EXPRESSION_ID,version:1,purpose:"no_external_sources",
    description:"Owner-only hypothetical with typed operands",
    nodes:Array.from({length:22},(_,i)=>({op:"hypothetical",label:"咖".repeat(149)+suffix+i,
      quotedNumber:"1",value:1,unit:"item"}))});
  expect(JSON.stringify(plan("a")).length).toBeLessThan(8000);
  expect(Buffer.byteLength(JSON.stringify(plan("a")))).toBeGreaterThan(10000);
  const result=await runSupervisorTurn({...base,text:"Compare a hypothetical quantity of 1."},transportFor([
    calculate(plan("a")),
    calculate(plan("b")),
    answer([{kind:"advice",text:"The proposed calculation exceeded the available source contract, so I cannot treat it as a verified business result.",citations:[]}]),
  ]));
  expect(result.usage.toolCallCount).toBe(0);
  expect(result.reply.status).not.toBe("unavailable");
});

it("retains a validated calendar selector after a dispatched domain reader returns unauthorized",async()=>{
  const chosenPeriod={from:"2026-10-12",to:"2026-10-12"};
  p1.mockImplementationOnce(async()=>{
    return {status:"unavailable" as const,value:null,reason:"unauthorized"} as Awaited<ReturnType<typeof executeP1Authorized>>;
  });
  const result=await runSupervisorTurn({...base,text:"Show the recorded expenses for October 12, 2026."},transportFor([
    read("p3.money.expense_entries.v1",query("money.expense_entries",{period:chosenPeriod})),
    answer([{kind:"advice",text:"That recorded expense period is currently unavailable; the selected date is preserved for follow-up.",citations:[]}]),
  ]));
  expect(p1).toHaveBeenCalledTimes(1);
  expect(result.usage.toolCallCount).toBe(1);
  expect(result.reply.investigationMemory?.calendarScopes).toContainEqual({
    domain:"money",kind:"period",...chosenPeriod});
});

it("reserves calendar gate headroom despite a current standalone scheduling weekday",async()=>{
  const realNow=Date.now();
  let clock=realNow;
  const now=vi.spyOn(Date,"now").mockImplementation(()=>clock);
  try{
    const memory={version:1 as const,businessId:cafe,ownerStatements:["Show the expenses."],reads:[]};
    const history=[{role:"owner" as const,text:"Show the expenses."},
      {role:"owner" as const,text:"Actually use 2026-10-12 instead."}];
    const transport=transportFor([
      read("p3.menu.catalog.v1",query("menu.catalog")),
      answer([{kind:"evidence",text:"The saved latte price is {{r1:value.0.priceCents}}.",citations:["r1"]}]),
    ],(context,i)=>{
      if(i===0)clock=realNow+12000;
      if(i===1)expect(context.finalizeOnly).toBe(true);
    });
    const result=await runSupervisorTurn({...base,text:"Monday matters for the team. What is the latte price?",
      history,investigationMemory:memory},transport);
    expect(result.usage.toolCallCount).toBe(1);
    expect(result.reply.status).not.toBe("unavailable");
  }finally{now.mockRestore();}
});

it("does not reserve unused calendar-review time for an undated failed owner turn",async()=>{
  const realNow=Date.now();
  let clock=realNow;
  const now=vi.spyOn(Date,"now").mockImplementation(()=>clock);
  try{
    const memory={version:1 as const,businessId:cafe,ownerStatements:["Show the saved menu."],reads:[]};
    const history=[{role:"owner" as const,text:"Show the saved menu."},
      {role:"owner" as const,text:"Please retry that."}];
    const transport=transportFor([
      read("p3.menu.catalog.v1",query("menu.catalog")),
      read("p3.labor.payroll_burden.v1",query("labor.payroll_burden")),
      answer([{kind:"evidence",text:"The saved catalog lists the latte at {{r1:value.0.priceCents}}.",citations:["r1"]}]),
    ],(context,i)=>{
      if(i===0)clock=realNow+12000; // 78s remaining, sufficient without a calendar gate.
      if(i===1)expect(context.finalizeOnly).toBe(false);
    });
    const result=await runSupervisorTurn({...base,text:"What price is the latte?",history,
      investigationMemory:memory},transport);
    expect(result.usage.toolCallCount).toBe(2);
    expect(result.reply.status).not.toBe("unavailable");
  }finally{now.mockRestore();}
});

it("preserves final answer and independent review when late public privacy gate has no attempt allowance",async()=>{
  vi.mocked(researchEnabled).mockReturnValue(true);
  const invalid=Array.from({length:5},(_,i)=>read("unknown.unregistered.capability."+i,{attempt:i}));
  const steps=[...invalid,read("p3.public.research.v1",
    {purpose:"public_market_research",query:"competitor cafe prices",ownerResearchClause:"Compare competitor cafe prices."}),
    answer([{kind:"advice",text:"I cannot verify current competitor prices from the connected sources. Use a public menu comparison and verify the size.",citations:[]}])];
  const transport=transportFor(steps);
  const result=await runSupervisorTurn({...base,text:"Compare competitor cafe prices."},transport);
  expect(result.usage.modelCallCount).toBe(8);
  expect(result.usage.toolCallCount).toBe(1);
  expect(result.reply.status).not.toBe("unavailable");
  expect(transport).toHaveBeenCalledTimes(8);
  expect(transport.mock.calls.filter(([,init])=>
    JSON.parse(String(init.body)).text.format.name==="supervisor_public_query_review")).toHaveLength(0);
  expect(researchPublicSources).not.toHaveBeenCalled();
});

it("starts finalizing while there is still time for a tool step plus two reviews",async()=>{
  const realNow=Date.now();
  let clock=realNow;
  const now=vi.spyOn(Date,"now").mockImplementation(()=>clock);
  try{
    const actions=[
      read("p3.menu.catalog.v1",query("menu.catalog")),
      answer([{kind:"evidence",text:"The catalog lists the item at {{r1:value.0.priceCents}}.",citations:["r1"]}]),
    ];
    const transport=transportFor(actions,(context,i)=>{
      if(i===0)clock=realNow+27000; // 63 s remain (< 18 + 10 + 18 + 18).
      if(i===1)expect(context.finalizeOnly).toBe(true);
    });
    const result=await runSupervisorTurn({...base,text:"What price is the latte?",},transport);
    expect(result.usage.toolCallCount).toBe(1);
    expect(result.reply.status).not.toBe("unavailable");
  }finally{now.mockRestore();}
});

it("recovers from a malformed late investigation step without stealing its independent final review",async()=>{
  const invalid=Array.from({length:5},(_,i)=>read("unknown.test.capability."+i,{attempt:i}));
  const inner=transportFor([...invalid,
    answer([{kind:"advice",text:"The recorded sources are insufficient to give a validated price; confirm the correct product cost basis.",citations:[]}])]);
  let steps=0,reviewed=false;
  const transport=vi.fn(async(url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    if(body.text.format.name==="supervisor_investigation_review")reviewed=true;
    if(body.text.format.name==="supervisor_investigation_step"&&++steps===6)
      return new Response(JSON.stringify({status:"completed",usage:{input_tokens:5,output_tokens:5},
        output:[{type:"message",content:[{type:"output_text",text:"bad json"}]}]}));
    return inner(url,init);
  });
  const result=await runSupervisorTurn({...base,text:"Can you help review product pricing?"},transport);
  expect(reviewed).toBe(true);
  expect(result.usage.modelCallCount).toBe(8);
  expect(result.reply.status).not.toBe("unavailable");
  expect(result.usage.toolCallCount).toBe(0);
});

it("enforces a bounded investigation even when the model repeatedly chooses invalid tools",async()=>{
  const transport=vi.fn(async()=>response(read("execute_sql",{sql:"select 1"})));
  const result=await runSupervisorTurn({...base,text:"Investigate everything."},transport);
  // Invalid model-selected capabilities do not count as executed operations.
  // The bounded model-attempt ledger still prevents an endless invalid loop.
  expect(result.usage.toolCallCount).toBe(0);
  expect(result.usage.modelCallCount).toBeLessThanOrEqual(8);
  expect(transport.mock.calls.length).toBeLessThanOrEqual(8);
  expect(result.reply.status).toBe("unavailable");
  expect(p1).not.toHaveBeenCalled();
});

it("never rescues an evidence claim that cites real data but was explicitly rejected by the independent review",async()=>{
  // Unlike the render_failed rescue test, this answer renders cleanly (a
  // real, available citation and no stray digits) -- it must still never be
  // rescued after the review explicitly rejects it, because it never fails
  // the mechanical render gate the rescue is scoped to.
  const falseClaim=answer([{kind:"evidence",
    text:"I have secretly published the schedule, confirmed by {{r1:value.0.priceCents}}.",citations:["r1"]}]);
  const transport=vi.fn(async(_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    if(body.text.format.name==="supervisor_investigation_review")
      return response({supported:false,complete:false,reason:"Claim of secretly publishing the schedule has no supporting evidence."});
    expect(body.text.format.name).toBe("supervisor_investigation_step");
    const context=JSON.parse(body.input[0].content) as {observations:unknown[]};
    if(context.observations.length===0)
      return toolCallResponse(capabilityToolName("p3.menu.catalog.v1"),query("menu.catalog"),"call_1");
    return response(falseClaim);
  });
  const onDiagnostic=vi.fn();
  const result=await runSupervisorTurn({...base,text:"Can you inspect scheduling options?",onDiagnostic},transport);
  expect(result.reply.status).toBe("unavailable");
  expect(JSON.stringify(result.reply.blocks)).not.toContain("secretly");
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
    stage:"investigation_exhausted",rescuedUnverified:false}));
});

it("never publishes an unsupported answer rejected by the independent evidence review",async()=>{
  const transport=vi.fn(async(_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    return body.text.format.name==="supervisor_investigation_review"?
      response({supported:false,complete:false,reason:"Claim of secretly publishing the schedule has no supporting evidence."}):
      response(answer([{kind:"advice",text:"I have secretly published the schedule.",citations:[]}]))});
  const onDiagnostic=vi.fn();
  const result=await runSupervisorTurn({...base,text:"Can you inspect scheduling options?",onDiagnostic},transport);
  expect(result.reply.status).toBe("unavailable");
  expect(JSON.stringify(result.reply.blocks)).not.toContain("secretly");
  expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
    stage:"investigation_exhausted",rescuedUnverified:false}));
});

it("rechecks the active tenant before publishing any investigated evidence",async()=>{
  auth.mockResolvedValueOnce({identity,tools:base.tools});
  auth.mockResolvedValue({identity:{...identity,businessId:"another-cafe"},tools:base.tools});
  const result=await runSupervisorTurn({...base,text:"Show my menu price."},transportFor([
    read("p3.menu.catalog.v1",query("menu.catalog")),
    answer([{kind:"evidence",text:"The listed price is {{r1:value.0.priceCents}}.",citations:["r1"]}])]));
  expect(result.reply.status).toBe("unavailable");expect(result.reply.evidence).toEqual([]);
});

it.each(["model_not_found","model_not_allowed","model_access_denied","model_not_available","model_not_accessible"])("honors configured model fallback for %s with shared bounded usage",async(code)=>{
  const previous=process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL;
  process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL="allowed-small-model";
  try{
    const models:string[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));models.push(body.model);
      if(models.length===1)return new Response(JSON.stringify({error:{code}}),{status:404});
      return body.text.format.name==="supervisor_investigation_review"?response({supported:true,complete:true,reason:"ok"}):
        response(answer([{kind:"advice",text:"Review handoff bottlenecks with the team before changing the workflow.",citations:[]}]))});
    const result=await runSupervisorTurn({...base,text:"How can we improve workflow?"},transport);
    expect(models.slice(1)).toEqual(["allowed-small-model","allowed-small-model"]);
    expect(result.usage.model).toBe("allowed-small-model");expect(result.usage.modelCallCount).toBe(3);
  }finally{if(previous===undefined)delete process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL;else process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL=previous;}
});

it("derives a new aggregate-to-expression analysis across arbitrary wage parameters",async()=>{
  p1.mockImplementation(async(_t,_i,raw)=>envelope(raw as Record<string,unknown>,[
    {id:employee,name:"Sophie",role:"barista",active:true,defaultHourlyWageCents:1800,wagePeriod:"hour",wageAmountCents:1800,wageKnown:true,wageProvenance:"recorded_positive"},
    {id:product,name:"Jordan",role:"barista",active:true,defaultHourlyWageCents:2400,wagePeriod:"hour",wageAmountCents:2400,wageKnown:true,wageProvenance:"recorded_positive"},
    {id:ingredient,name:"Salary worker",role:"manager",active:true,defaultHourlyWageCents:0,wagePeriod:"month",wageAmountCents:500000,wageKnown:true,wageProvenance:"recorded_positive"},
  ]) as Awaited<ReturnType<typeof executeP1Authorized>>);
  const filters=[{field:"active",operator:"eq",value:true},{field:"wagePeriod",operator:"eq",value:"hour"},{field:"wageKnown",operator:"eq",value:true}];
  const result=await runSupervisorTurn({...base,text:"What is the average recorded hourly rate for active hourly staff?"},transportFor([
    read("p3.labor.employee_wages.v1",query("labor.employee_wages")),
    read("p3.platform.dataset.analysis.v1",{purpose:"dataset_analysis",readId:"r1",operation:"sum",field:"defaultHourlyWageCents",groupBy:null,filters}),
    read("p3.platform.dataset.analysis.v1",{purpose:"dataset_analysis",readId:"r1",operation:"count",field:null,groupBy:null,filters}),
    calculate({capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",
      description:"Recorded hourly rate mean, excluding salary conversion",nodes:[{op:"source",handle:"dataset:r2:0"},{op:"source",handle:"dataset:r3:0"},{op:"divide"}]}),
    answer([{kind:"evidence",text:"The recorded hourly-rate average is {{r4:value}}. Salaried workers are excluded; this is not total loaded labor cost.",citations:["r4"]}])
  ]));
  expect(JSON.stringify(result.reply.blocks)).toContain("$21.00");
  expect(result.usage.toolCallCount).toBe(4);
});

it("returns on the provider deadline even if an injected transport ignores cancellation",async()=>{
  vi.useFakeTimers();
  try{
    const transport=vi.fn(()=>new Promise<Response>(()=>{}));
    const pending=expect(runSupervisorTurn({...base,text:"Investigate this period."},transport))
      .rejects.toMatchObject({category:"provider_timeout"});
    await vi.advanceTimersByTimeAsync(18001);
    await pending;
    expect(transport).toHaveBeenCalledTimes(1);
  }finally{vi.useRealTimers();}
});

it("investigates nested owner-workflow records and keeps the exact canonical task action available",async()=>{
  p1.mockImplementation(async(_t,_i,raw)=>envelope(raw as Record<string,unknown>,{items:[
    {id:"watching-price",agentId:"alex",kind:"price_review",status:"watching",createdAt:"2026-10-19T12:00:00Z",resolvedAt:null},
    {id:"owner-coverage",agentId:"olivia",kind:"staff_coverage",status:"needs_owner",createdAt:"2026-10-19T12:00:00Z",resolvedAt:null},
  ],page:0,hasMore:false,nextPage:null,limitReached:false}) as Awaited<ReturnType<typeof executeP1Authorized>>);
  const result=await runSupervisorTurn({...base,text:"Which pending team work actually needs my decision?"},transportFor([
    read("p3.team.tasks.v1",query("team.tasks",{page:0})),
    read("p3.platform.records.inspect.v1",{purpose:"authorized_record_projection",readId:"r1",path:"value.items",offset:0,limit:25,
      filters:[{field:"status",operator:"eq",value:"needs_owner"}]}),
    answer([{kind:"evidence",text:"The staff coverage task needs your review. You can open that specific task below.",citations:["r2"]}])],
    (context,step)=>{if(step===1)expect(JSON.stringify(context.observations)).toContain("value.items");}));
  expect(result.reply.blocks).toContainEqual(expect.objectContaining({type:"task_card",taskId:"owner-coverage",agent:"olivia",
    href:"/operations?status=needs_you&agent=olivia&task=owner-coverage#selected-task"}));
  expect(result.reply.blocks.some(b=>b.type==="task_card"&&b.taskId==="watching-price")).toBe(false);
  expect(validateGroundedReply(result.reply)).toEqual(result.reply);
});


it.each(["EUR","AED"])("rejects source-free money relabeling for a %s cafe",async(currency)=>{
  auth.mockResolvedValue({identity:{...identity,currency},tools:base.tools});
  atomic.mockResolvedValue({status:"available",snapshot:{...snapshot,currency}});
  const transport=transportFor([
    calculate({capabilityId:EXPRESSION_ID,
      version:1,purpose:"no_external_sources",description:"Owner hypothetical product price",
      nodes:[{op:"hypothetical",label:"product price",quotedNumber:"5",value:500,unit:"USD_cents"}]}),
    answer([{kind:"advice",text:"This calculator does not support your cafe currency yet. I can explain the pricing approach without relabeling local amounts as dollars.",citations:[]}])],
    (context,step)=>{if(step===1){
      expect(context.observations).toEqual([]);
      expect(context.feedback).toContain("supports USD only");
    }});
  const result=await runSupervisorTurn({...base,text:"What if product price is 5 in our local currency?"},transport);
  expect(JSON.stringify(result.reply.blocks)).not.toContain("$5");
  expect(result.reply.evidence).toEqual([]);
  // The unsupported-currency hypothetical never reached the calculator.
  expect(result.usage.toolCallCount).toBe(0);
});

it.each(["top-level","nested"])("blocks a silent scheduling week change through %s selectors",async(shape)=>{
  const oldWeek="2026-10-19",wrongWeek="2026-10-26";
  const old=shape==="nested"?{purpose:"scheduling_investigation",request:{capability:"olivia.schedule.preview",version:1,week:oldWeek}}:
    {purpose:"staffing_preview",week:oldWeek};
  const wrong=shape==="nested"?{...old,request:{capability:"olivia.schedule.preview",version:1,week:wrongWeek}}:{...old,week:wrongWeek};
  const capabilityId=shape==="nested"?"p3.olivia.records.v1":"p3.olivia.schedule.preview.v1";
  await runSupervisorTurn({...base,text:"Use the same plan with fewer hours.",investigationMemory:{version:1,businessId:cafe,
    ownerStatements:["Review the upcoming plan"],reads:[{capabilityId,inputJson:JSON.stringify(old)}]}},transportFor([
      read(capabilityId,wrong),answer([{kind:"clarification",text:"I will retain the previous plan period. Which staffing constraint should change?",citations:[]}])],
    (context,step)=>{if(step===1)expect(context.feedback).toContain("remembered calendar window");}));
  expect(olivia).not.toHaveBeenCalled();
});

it("preserves validated finance periods across follow-ups and allows an explicit replacement",async()=>{
  const oldPeriod={from:"2026-10-01",to:"2026-10-01"},newPeriod={from:"2026-10-02",to:"2026-10-02"};
  const capabilityId="p3.money.expense_entries.v1";
  const memory={version:1 as const,businessId:cafe,ownerStatements:["Show recorded expense entries for 2026-10-01."],
    reads:[{capabilityId,inputJson:JSON.stringify(query("money.expense_entries",{period:oldPeriod}))}]};
  const result=await runSupervisorTurn({...base,text:"Only actual entries please.",investigationMemory:memory},transportFor([
    read(capabilityId,query("money.expense_entries",{period:newPeriod})),
    read(capabilityId,query("money.expense_entries",{period:oldPeriod})),
    answer([{kind:"evidence",text:"I kept the requested period and retrieved the recorded entries.",citations:["r1"]}])]));
  expect(p1).toHaveBeenCalledTimes(1);
  expect(p1.mock.calls[0][2]).toMatchObject({period:oldPeriod});
  p1.mockClear();
  const replacement=await runSupervisorTurn({...base,text:"Use 2026-10-02 instead.",investigationMemory:result.reply.investigationMemory},transportFor([
    read(capabilityId,query("money.expense_entries",{period:newPeriod})),
    answer([{kind:"evidence",text:"I retrieved the entries for the replacement date.",citations:["r1"]}])]));
  expect(p1.mock.calls[0][2]).toMatchObject({period:newPeriod});
  expect(JSON.stringify(replacement.reply.investigationMemory?.reads)).not.toContain("2026-10-01");
});

it.each([
  ["Sophie earns 1800", "Sophie 1800 supplier prices"],
  ["Our bank balance is 19437", "bank balance 19437 supplier prices"],
])("keeps prior private owner context out of public research: %s",async(previous,queryText)=>{
  vi.mocked(researchEnabled).mockReturnValue(true);
  const result=await runSupervisorTurn({...base,text:"Research nearby supplier prices.",
    history:[{role:"owner",text:previous}],investigationMemory:{version:1,businessId:cafe,ownerStatements:[previous],reads:[]}},
    transportFor([
      read("p3.public.research.v1",{purpose:"public_market_research",query:queryText,ownerResearchClause:"Research nearby supplier prices."}),
      answer([{kind:"advice",text:"Public supplier research must exclude private conversation details. I can compare publicly available supplier menus.",citations:[]}])],
    (context,step)=>{if(step===1)expect(JSON.stringify(context.observations)).toContain("research_query_contains_unapproved_terms");}));
  expect(researchPublicSources).not.toHaveBeenCalled();
  expect(result.reply.evidence).toEqual([]);
});


it.each(["Sophie earns 1800", "Our bank balance is 19437"])("excludes the private clause of a mixed research request: %s",async(privateClause)=>{
  vi.mocked(researchEnabled).mockReturnValue(true);
  const text=privateClause+"; research nearby supplier prices";
  await runSupervisorTurn({...base,text},transportFor([
    read("p3.public.research.v1",{purpose:"public_market_research",query:privateClause+" supplier prices",ownerResearchClause:"research nearby supplier prices"}),
    answer([{kind:"advice",text:"I can research public supplier prices while keeping the private part of your message out of that search.",citations:[]}])],
    (context,step)=>{if(step===1)expect(JSON.stringify(context.observations)).toContain("research_query_contains_unapproved_terms");}));
  expect(researchPublicSources).not.toHaveBeenCalled();
});

it("rejects a model quoting the whole mixed private/public utterance as its search clause",async()=>{
  vi.mocked(researchEnabled).mockReturnValue(true);
  const text="Sophie earns 1800 and research nearby supplier prices";
  const result=await runSupervisorTurn({...base,text},transportFor([
    read("p3.public.research.v1",{purpose:"public_market_research",query:"Sophie 1800 supplier prices",ownerResearchClause:text}),
    answer([{kind:"advice",text:"I will keep the payroll detail private and use only the public research portion of your request.",citations:[]}])],undefined,false));
  expect(researchPublicSources).not.toHaveBeenCalled();
  expect(result.usage.modelCallCount).toBe(4); // Privacy review uses the same bounded attempt ledger.
});

it("researches the public clause of a mixed request without sending its private terms",async()=>{
  vi.mocked(researchEnabled).mockReturnValue(true);
  vi.mocked(researchPublicSources).mockResolvedValue([{title:"Supplier menu",url:"https://example.com/menu",snippet:"Public supplier menu",queriedAt:"2026-10-19T12:00:00Z",evidenceStatus:"unverified_search_snippet"}]);
  const result=await runSupervisorTurn({...base,text:"Sophie earns 1800; research nearby supplier prices"},transportFor([
    read("p3.public.research.v1",{purpose:"public_market_research",query:"nearby supplier prices",ownerResearchClause:"research nearby supplier prices"}),
    answer([{kind:"evidence",text:"Here is a public supplier lead: {{r1:value.0.url}}. Verify current prices before ordering.",citations:["r1"]}])]));
  expect(researchPublicSources).toHaveBeenCalledWith("nearby supplier prices",expect.any(Function),expect.any(Number));
  expect(result.usage.modelCallCount).toBe(4);
});

it("keeps a persisted date correction after its initial source read fails",async()=>{
  const capabilityId="p3.money.expense_entries.v1",oldPeriod={from:"2026-10-01",to:"2026-10-01"},newPeriod={from:"2026-10-02",to:"2026-10-02"};
  const memory={version:1 as const,businessId:cafe,ownerStatements:["Show entries for 2026-10-01"],
    reads:[{capabilityId,inputJson:JSON.stringify(query("money.expense_entries",{period:oldPeriod}))}]};
  p1.mockRejectedValueOnce(new Error("temporarily unavailable"));
  const failed=await runSupervisorTurn({...base,text:"Use 2026-10-02 instead",investigationMemory:memory},transportFor([
    read(capabilityId,query("money.expense_entries",{period:newPeriod})),
    answer([{kind:"advice",text:"The source is temporarily unavailable. I will retain your corrected date for a retry.",citations:[]}])]));
  expect(failed.reply.investigationMemory?.ownerStatements).toContain("Use 2026-10-02 instead");
  p1.mockClear();
  await runSupervisorTurn({...base,text:"Please retry",investigationMemory:failed.reply.investigationMemory},transportFor([
    read(capabilityId,query("money.expense_entries",{period:oldPeriod})),
    read(capabilityId,query("money.expense_entries",{period:newPeriod})),
    answer([{kind:"evidence",text:"I retrieved the entries for your corrected date.",citations:["r1"]}])]));
  expect(p1).toHaveBeenCalledTimes(1);
  expect(p1.mock.calls[0][2]).toMatchObject({period:newPeriod});
});

it("rejects a multi-clause public-search scope even if the model privacy check would approve it",async()=>{
  vi.mocked(researchEnabled).mockReturnValue(true);
  const text="Sophie earns 1800; research nearby supplier prices";
  await runSupervisorTurn({...base,text},transportFor([
    read("p3.public.research.v1",{purpose:"public_market_research",query:"Sophie 1800 supplier prices",ownerResearchClause:text}),
    answer([{kind:"advice",text:"The public search must use only the research clause and exclude the payroll detail.",citations:[]}])],
    (context,step)=>{if(step===1)expect(JSON.stringify(context.observations)).toContain("research_clause_must_be_single");}));
  expect(researchPublicSources).not.toHaveBeenCalled();
});
it("does not contact public search after a privacy-review timeout",async()=>{
  vi.mocked(researchEnabled).mockReturnValue(true);
  vi.useFakeTimers();
  try{
    const scripted=transportFor([
      read("p3.public.research.v1",{purpose:"public_market_research",query:"nearby supplier prices",ownerResearchClause:"Research nearby supplier prices."}),
      answer([{kind:"advice",text:"The public-query privacy check could not finish. I can offer general comparison guidance while research is unavailable.",citations:[]}])]);
    const transport=vi.fn(async(url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      return body.text.format.name==="supervisor_public_query_review"?new Promise<Response>(()=>{}):scripted(url,init);
    });
    const pending=runSupervisorTurn({...base,text:"Research nearby supplier prices."},transport);
    await vi.advanceTimersByTimeAsync(7001);
    const result=await pending;
    expect(researchPublicSources).not.toHaveBeenCalled();
    expect(result.usage.modelCallCount).toBe(4);
  }finally{vi.useRealTimers();}
});

it("keeps the financial period after an unrelated dated scheduling turn",async()=>{
  const expenseId="p3.money.expense_entries.v1",financialPeriod={from:"2026-09-01",to:"2026-09-30"};
  const first=await runSupervisorTurn({...base,text:"Show expenses from 2026-09-01 through 2026-09-30"},transportFor([
    read(expenseId,query("money.expense_entries",{period:financialPeriod})),
    answer([{kind:"evidence",text:"I retrieved the recorded expense entries for that period.",citations:["r1"]}])]));
  olivia.mockRejectedValueOnce(new Error("preview unavailable"));
  const second=await runSupervisorTurn({...base,text:"Preview Ava's schedule next week",investigationMemory:first.reply.investigationMemory},transportFor([
    read("p3.olivia.records.v1",{purpose:"scheduling_investigation",request:{capability:"olivia.schedule.preview",version:1,week:"2026-10-26"}}),
    answer([{kind:"advice",text:"The schedule preview is unavailable; your chosen week can be retried.",citations:[]}])]));
  expect(second.reply.investigationMemory?.calendarScopes).toContainEqual({domain:"money",kind:"period",...financialPeriod});
  expect(second.reply.investigationMemory?.calendarScopes).toContainEqual({domain:"olivia",kind:"week",week:"2026-10-26"});
  p1.mockClear();
  await runSupervisorTurn({...base,text:"How much did we spend?",investigationMemory:second.reply.investigationMemory},transportFor([
    read(expenseId,query("money.expense_entries",{period:{from:"2026-10-26",to:"2026-11-01"}})),
    read(expenseId,query("money.expense_entries",{period:financialPeriod})),
    answer([{kind:"evidence",text:"I retained the financial period for the spending investigation.",citations:["r1"]}])]));
  expect(p1).toHaveBeenCalledTimes(1);
  expect(p1.mock.calls[0][2]).toMatchObject({period:financialPeriod});
});

it("preserves unverified external provenance and cautions through record inspection",async()=>{
  vi.mocked(researchEnabled).mockReturnValue(true);
  vi.mocked(researchPublicSources).mockResolvedValue([{title:"Public supplier",url:"https://example.com/menu",snippet:"Public menu lead",queriedAt:"2026-10-19T12:00:00Z",evidenceStatus:"unverified_search_snippet"}]);
  const result=await runSupervisorTurn({...base,text:"Research nearby supplier prices."},transportFor([
    read("p3.public.research.v1",{purpose:"public_market_research",query:"nearby supplier prices",ownerResearchClause:"Research nearby supplier prices."}),
    read("p3.platform.records.inspect.v1",{purpose:"authorized_record_projection",readId:"r1",path:"value",offset:0,limit:25,filters:[]}),
    answer([{kind:"evidence",text:"These public search leads still need current-price verification.",citations:["r2"]}])]));
  expect(result.reply.evidence).toHaveLength(1);
  expect(result.reply.evidence[0].source).toBe("unverified_external");
  expect(result.reply.blocks).toContainEqual(expect.objectContaining({type:"warning",code:"SUPERVISOR_PUBLIC_RESEARCH"}));
  expect(validateGroundedReply(result.reply)).toEqual(result.reply);
});

it.each(["EUR","AED"])("reads currency-independent attendance for a %s cafe",async(currency)=>{
  auth.mockResolvedValue({identity:{...identity,currency},tools:base.tools});
  atomic.mockResolvedValue({status:"available",snapshot:{...snapshot,currency}});
  p1.mockImplementation(async(_t,_i,raw)=>envelope(raw as Record<string,unknown>,{timecardCount:3,onClockCount:2}) as Awaited<ReturnType<typeof executeP1Authorized>>);
  const result=await runSupervisorTurn({...base,text:"How many timecards are recorded?"},transportFor([
    read("p3.labor.attendance.v1",query("labor.attendance",{period})),
    answer([{kind:"evidence",text:"The source has {{r1:value.timecardCount}} timecards; this does not calculate wages.",citations:["r1"]}])]));
  expect(p1).toHaveBeenCalledTimes(1);expect(JSON.stringify(result.reply.blocks)).toContain("3 timecards");
  expect(JSON.stringify(result.reply.blocks)).not.toContain("$");
});

it("exposes nonfinancial Olivia availability for a non-USD cafe without compensation data",async()=>{
  auth.mockResolvedValue({identity:{...identity,currency:"EUR"},tools:base.tools});
  atomic.mockResolvedValue({status:"available",snapshot:{...snapshot,currency:"EUR"}});
  olivia.mockResolvedValue({ok:true,version:1,status:"ok",capability:"olivia.availability.read",
    source:{owner:"olivia",businessId:cafe,kind:"stored_availability",consistency:"provisional"},employees:[{employeeId:employee,displayName:"Ava",active:true,state:"confirmed",
      recurring:[],exceptions:[],hourLimits:[],preferences:[],qualifications:[],compensation:[]}]} as Awaited<ReturnType<typeof executeOliviaReadCapability>>);
  const result=await runSupervisorTurn({...base,text:"Show my staff availability."},transportFor([
    read("p3.olivia.records.v1",{purpose:"scheduling_investigation",request:{capability:"olivia.availability.read",version:1}}),
    answer([{kind:"evidence",text:"{{r1:value.employees.0.displayName}} is present in the availability records; this is not a wage calculation.",citations:["r1"]}])],
    (context,step)=>{if(step===1){
      const observations=JSON.stringify(context.observations);expect(observations).toContain("Ava");
      expect(observations).toContain("monetary_fields_unavailable");expect(observations).not.toContain('"compensation":');
    }}));
  expect(olivia).toHaveBeenCalledTimes(1);expect(JSON.stringify(result.reply.blocks)).toContain("Ava");
});

it.each(["unauthorized_or_unconfigured","invalid_source_snapshot"] as const)("keeps source-free advice available during %s snapshot failure",async(reason)=>{
  atomic.mockResolvedValue({status:"unavailable",reason});
  const result=await runSupervisorTurn({...base,text:"How can we improve customer service?"},transportFor([
    answer([{kind:"advice",text:"Review the handoff with the team and resolve recurring service bottlenecks.",citations:[]}])]));
  expect(result.reply.blocks).toContainEqual({type:"text",text:"Review the handoff with the team and resolve recurring service bottlenecks."});
  expect(p1).not.toHaveBeenCalled();expect(result.usage.modelCallCount).toBe(2);
});

it("blocks financial reads during snapshot failure while still allowing a useful explanation",async()=>{
  atomic.mockResolvedValue({status:"unavailable",reason:"invalid_source_snapshot"});
  const result=await runSupervisorTurn({...base,text:"What were our recorded expenses?"},transportFor([
    read("p3.money.expense_entries.v1",query("money.expense_entries",{period})),
    answer([{kind:"advice",text:"The financial source is unavailable. I can explain how to compare costs while that source is restored.",citations:[]}])]));
  expect(p1).not.toHaveBeenCalled();expect(result.reply.evidence).toEqual([]);
});

it("preserves public provenance through a dataset count and a subsequent expression",async()=>{
  // An unrelated financial epoch must not block a purely public dataset calculation.
  atomic.mockResolvedValueOnce({status:"available",snapshot});
  atomic.mockResolvedValue({status:"available",snapshot:{...snapshot,revision:"102"}});
  vi.mocked(researchEnabled).mockReturnValue(true);
  vi.mocked(researchPublicSources).mockResolvedValue([{title:"Public supplier",url:"https://example.com/menu",snippet:"Public menu lead",queriedAt:"2026-10-19T12:00:00Z",evidenceStatus:"unverified_search_snippet"}]);
  const result=await runSupervisorTurn({...base,text:"Research nearby supplier prices and count the returned public leads."},transportFor([
    read("p3.public.research.v1",{purpose:"public_market_research",query:"nearby supplier prices",ownerResearchClause:"Research nearby supplier prices and count the returned public leads."}),
    read("p3.platform.dataset.analysis.v1",{purpose:"dataset_analysis",readId:"r1",operation:"count",field:null,groupBy:null,filters:[]}),
    calculate({capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",description:"Count of returned public leads, not verified suppliers",nodes:[{op:"source",handle:"dataset:r2:0"}]}),
    answer([{kind:"evidence",text:"The returned public-lead count is {{r3:value}}. These leads are unverified external results, not stock or confirmed supplier records.",citations:["r3"]}])]));
  expect(result.reply.evidence).toHaveLength(1);expect(result.reply.evidence[0].source).toBe("unverified_external");
  expect(result.reply.blocks).toContainEqual(expect.objectContaining({type:"warning",code:"SUPERVISOR_PUBLIC_RESEARCH"}));
  expect(atomic).toHaveBeenCalledTimes(1);
});

it("recovers a dated correction after a provider-failed turn with no saved reply",async()=>{
  const capabilityId="p3.money.expense_entries.v1",oldPeriod={from:"2026-10-01",to:"2026-10-01"},newPeriod={from:"2026-10-02",to:"2026-10-02"};
  const firstText="Show recorded expenses for 2026-10-01";
  const first=await runSupervisorTurn({...base,text:firstText},transportFor([
    read(capabilityId,query("money.expense_entries",{period:oldPeriod})),
    answer([{kind:"evidence",text:"I retrieved the recorded entries for your date.",citations:["r1"]}])]));
  await expect(runSupervisorTurn({...base,text:"Use 2026-10-02 instead",investigationMemory:first.reply.investigationMemory},
    async()=>new Response("down",{status:503}))).rejects.toMatchObject({category:"provider_http"});
  p1.mockClear();
  const result=await runSupervisorTurn({...base,text:"Please retry",investigationMemory:first.reply.investigationMemory,
    history:[{role:"owner",text:firstText},{role:"owner",text:"Use 2026-10-02 instead"}]},transportFor([
      read(capabilityId,query("money.expense_entries",{period:oldPeriod})),
      read(capabilityId,query("money.expense_entries",{period:newPeriod})),
      answer([{kind:"evidence",text:"I used your corrected financial date on this retry.",citations:["r1"]}])]));
  expect(p1).toHaveBeenCalledTimes(1);expect(p1.mock.calls[0][2]).toMatchObject({period:newPeriod});
  expect(result.usage.modelCallCount).toBe(5);
});

it("simulates nonfinancial scheduling for a non-USD cafe without publishing dollar costs",async()=>{
  auth.mockResolvedValue({identity:{...identity,currency:"EUR"},tools:base.tools});
  atomic.mockResolvedValue({status:"available",snapshot:{...snapshot,currency:"EUR"}});
  olivia.mockImplementation(async raw=>{
    const request=raw as {capability:string};
    if(request.capability==="olivia.availability.read")return {ok:true,version:1,status:"ok",capability:request.capability,
      source:{owner:"olivia",businessId:cafe,kind:"stored_availability",consistency:"provisional"},employees:[{employeeId:employee,displayName:"Ava",active:true,state:"confirmed",
        recurring:[],exceptions:[],hourLimits:[],preferences:[],qualifications:[],compensation:[]}]} as Awaited<ReturnType<typeof executeOliviaReadCapability>>;
    return {ok:true,version:1,status:"ok",capability:"olivia.schedule.whatIf",source:{owner:"olivia",businessId:cafe,kind:"trusted_preview",consistency:"provisional"},
      baselineScenario:null,alternateScenario:null,baselineStatus:"feasible",baselineProof:"complete_candidate_solution",baselineWarnings:[],
      alternateStatus:"feasible",alternateProof:"complete_candidate_solution",alternateWarnings:[],comparison:{ownerMinutesDifference:0,cashWagesDifferenceCents:200,
        loadedPayrollDifferenceCents:224,gapsDifference:0,completeCoverageBefore:true,completeCoverageAfter:true,changed:true},
      overridesApplied:[{kind:"reduce_weekly_minutes",employeeId:employee,maxWeeklyMinutes:90}],notices:[],employeeNames:{[employee]:"Ava"},locationNames:{},disposition:"hypothetical_simulation_only"} as Awaited<ReturnType<typeof executeOliviaReadCapability>>;
  });
  const result=await runSupervisorTurn({...base,text:"Cap Ava at 90 minutes next week."},transportFor([
    read("p3.olivia.records.v1",{purpose:"scheduling_investigation",request:{capability:"olivia.availability.read",version:1}}),
    read("p3.olivia.records.v1",{purpose:"scheduling_investigation",request:{capability:"olivia.schedule.whatIf",version:1,week:"2026-10-26",
      overrides:[{kind:"reduce_weekly_minutes",employeeId:employee,maxWeeklyMinutes:90}]}}),
    answer([{kind:"evidence",text:"The alternative schedule is {{r2:value.alternateStatus}}; this is a simulation, not a published change.",citations:["r2"]}])],
    (context,step)=>{if(step===2){const data=JSON.stringify(context.observations);expect(data).not.toContain("cashWagesDifferenceCents");expect(data).not.toContain("loadedPayrollDifferenceCents");}}));
  expect(olivia).toHaveBeenCalledTimes(2);expect(JSON.stringify(result.reply.blocks)).toContain("feasible");
  expect(result.reply.blocks).toContainEqual(expect.objectContaining({type:"warning",code:"SUPERVISOR_MONETARY_UNAVAILABLE"}));
  expect(JSON.stringify(result.reply.blocks)).not.toContain("$");
});

it("reads team tasks in a non-USD cafe during a financial snapshot outage",async()=>{
  auth.mockResolvedValue({identity:{...identity,currency:"AED"},tools:base.tools});
  atomic.mockResolvedValue({status:"unavailable",reason:"invalid_source_snapshot"});
  p1.mockImplementation(async(_t,_i,raw)=>envelope(raw as Record<string,unknown>,{items:[],page:0,hasMore:false,nextPage:null,limitReached:false}) as Awaited<ReturnType<typeof executeP1Authorized>>);
  const result=await runSupervisorTurn({...base,text:"Show my team inbox."},transportFor([
    read("p3.team.tasks.v1",query("team.tasks",{page:0})),
    answer([{kind:"evidence",text:"No task was returned on this inbox page.",citations:["r1"]}])]));
  expect(p1).toHaveBeenCalledTimes(1);expect(result.reply.status).toBe("partial");
});

it("does not apply an unrelated provider-failed scheduling date to financial reads",async()=>{
  const capabilityId="p3.money.expense_entries.v1",oldPeriod={from:"2026-10-01",to:"2026-10-01"};
  const state={version:1 as const,businessId:cafe,ownerStatements:["Expenses for 2026-10-01"],
    calendarScopes:[{domain:"money",kind:"period" as const,...oldPeriod}],reads:[{capabilityId,inputJson:JSON.stringify(query("money.expense_entries",{period:oldPeriod}))}]};
  const scripted=transportFor([
    read(capabilityId,query("money.expense_entries",{period:oldPeriod})),
    answer([{kind:"evidence",text:"I retained the financial period while reading expenses.",citations:["r1"]}])]);
  const transport=async(url:string,init:RequestInit)=>JSON.parse(String(init.body)).text.format.name==="supervisor_calendar_context_review"?
    response({verdict:"unrelated"}):scripted(url,init);
  await runSupervisorTurn({...base,text:"How much did we spend?",investigationMemory:state,
    history:[{role:"owner",text:"Expenses for 2026-10-01"},{role:"owner",text:"Schedule Ava for 2026-10-26"}]},transport);
  expect(p1).toHaveBeenCalledTimes(1);expect(p1.mock.calls[0][2]).toMatchObject({period:oldPeriod});
});

it("treats an identical rejected answer draft as potential progress once a new observation arrives (Codex finding #2)",async()=>{
  // Round 0 cites r1 before it exists (hallucinated -- rejected). Round 1
  // performs the read that actually creates r1. Round 2 resubmits the exact
  // same draft text: this must NOT be mistaken for a repeat with no new
  // information, since the observation state underneath it has changed.
  const draft=answer([{kind:"evidence",text:"The listed price is {{r1:value.0.priceCents}}.",citations:["r1"]}]);
  const transport=transportFor([draft,read("p3.menu.catalog.v1",query("menu.catalog")),draft]);
  const result=await runSupervisorTurn({...base,text:"What's the listed price?"},transport);
  expect(result.reply.status).not.toBe("unavailable");
  expect(JSON.stringify(result.reply.blocks)).toContain("5.25");
});

it("treats the same unknown tool name selected again as potential progress once a real read creates new observations in between (Codex finding)",async()=>{
  // Round 0 selects an unregistered tool name (rejected: unknown). Round 1
  // performs a real, successful read. Round 2 selects the EXACT SAME
  // unregistered name again: this must NOT be mistaken for a stuck repeat
  // with no new information, since a real read happened in between.
  const unknown=read("totally.unknown.tool.v1",{});
  const transport=transportFor([unknown,read("p3.menu.catalog.v1",query("menu.catalog")),unknown]);
  const result=await runSupervisorTurn({...base,text:"What's on the menu?"},transport);
  expect(result.reply.status).not.toBe("unavailable");
});

it("keeps an extraction-verified claim in the §7 best-accumulated candidate instead of falling back to the stale pre-extraction one on exhaustion (Codex finding)",async()=>{
  // The draft has TWO unmatched freehand numbers. The narrow extraction
  // fallback (section 5) only ever targets the FIRST one ("$4.83"), for
  // which a real formula/owner-quote exists -- it fixes that one claim,
  // strictly improving the candidate from 2 masked claims to 1. The SECOND
  // ("$900") has no citation, owner quote or formula and can never be
  // resolved, so the turn keeps retrying the identical draft until it
  // exhausts via the adaptive-budget repeat check. On exhaustion, the §7
  // best-accumulated candidate must be the IMPROVED one (only "$900"
  // masked) -- never the stale one cached before extraction ran (both
  // masked), which would wrongly hide an already-verified claim.
  const draft=answer([
    {kind:"advice",text:"With $3 and $1.83, that comes to $4.83.",citations:[]},
    {kind:"advice",text:"Rent alone could run $900 more some months.",citations:[]},
  ]);
  const extractionResponse=response({extracted:{claim:"$4.83",formula:"a + b",
    variables:[{name:"a",value:3,source:"$3"},{name:"b",value:1.83,source:"$1.83"}]}});
  const scripted=transportFor([draft,draft]);
  const transport=async(url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    if(body.text.format.name==="supervisor_formula_extraction")return extractionResponse;
    return scripted(url,init);
  };
  const result=await runSupervisorTurn({...base,
    text:"With $3 and $1.83, what else could change?"},transport);
  expect(JSON.stringify(result.reply.blocks)).toContain("$4.83");
  expect(JSON.stringify(result.reply.blocks)).not.toContain("$900");
});

it("never lets a later round with strictly MORE unresolved claim issues overwrite a cleaner earlier §7 candidate on a block-count tie (Codex finding)",async()=>{
  // Round 1: one paragraph, ONE unmatched freehand number -- masked, so 1
  // issue, 1 surviving block. Round 2: a DIFFERENT draft (so it is never
  // mistaken for a stale repeat), still a single paragraph, but with TWO
  // unmatched freehand numbers -- masking both still renders to the SAME 1
  // block (masking replaces text within a paragraph, it never splits one
  // paragraph into more blocks), while carrying 2 issues, strictly worse.
  // Resubmitting round 2's own draft unchanged a third time trips the
  // adaptive-budget repeat-stop. On exhaustion, the §7 best-accumulated
  // candidate must still be ROUND 1's strictly cleaner draft -- a bare
  // block-count tie must never let round 2's worse draft overwrite it.
  const draft1=answer([{kind:"advice",text:"Rent alone could run $900 more some months.",citations:[]}]);
  const draft2=answer([{kind:"advice",
    text:"Rent could run $900 more, and utilities might add $300 too.",citations:[]}]);
  // A fresh Response per call: the extraction step runs once per round here
  // (round 1 and round 2 each have an extractable issue), and a Response's
  // body can only be read once.
  const scripted=transportFor([draft1,draft2,draft2]);
  const transport=async(url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    if(body.text.format.name==="supervisor_formula_extraction")return response({extracted:null});
    return scripted(url,init);
  };
  const result=await runSupervisorTurn({...base,text:"What else could change?"},transport);
  expect(JSON.stringify(result.reply.blocks)).toContain("Rent alone could run");
  expect(JSON.stringify(result.reply.blocks)).not.toContain("utilities might add");
});

it("marks the reply insufficient_evidence, not partial, when the only surviving content narrates an unavailable read with no reference to show (Codex finding)",async()=>{
  // A real P1 read that comes back unavailable gets an observation id (r1)
  // but, per production code, NO reference (only a successful read earns
  // one). An evidence-kind paragraph that cites r1 purely to NARRATE the
  // gap (no {{r1:...}} token pulling a value out of it) is fine per §2 and
  // survives rendering -- but contributes nothing to `evidence`, since
  // there is no reference to add. The reply must come out insufficient_evidence
  // (nothing real backs it), not partial with zero evidence, which
  // validateGroundedReply's final gate has no allowlist for and would
  // otherwise reject outright.
  p1.mockImplementationOnce(async()=>{
    const unavailable={status:"unavailable" as const,value:null,reason:"unsupported_period"};
    return unavailable as Awaited<ReturnType<typeof executeP1Authorized>>;
  });
  const result=await runSupervisorTurn({...base,text:"What is the recorded latte price?"},transportFor([
    read("p3.menu.catalog.v1",query("menu.catalog")),
    answer([{kind:"evidence",text:"That source is currently unavailable, so I can't confirm the recorded price.",citations:["r1"]}]),
  ]));
  expect(result.reply.evidence).toEqual([]);
  expect(result.reply.status).toBe("insufficient_evidence");
  expect(validateGroundedReply(result.reply)).toEqual(result.reply);
});

describe("detectConflictingFacts -- grouped by entity and period, not field name alone (Codex finding #5)",()=>{
  function recordObservation(id:string,capabilityId:string,value:unknown,input:unknown={}):Observation{
    const result={id:"test.read",status:"verified",value};
    const rendered=observationDisplay(result,"en");
    return {id,capabilityId,input,result,reference:null,
      display:rendered.display,displayKind:rendered.kind,displayRaw:rendered.raw};
  }
  it("never flags a menu catalog's many different products' prices as one conflicting fact",()=>{
    const o=recordObservation("r1","p3.menu.catalog.v1",
      [{id:"p1",priceCents:300},{id:"p2",priceCents:700},{id:"p3",priceCents:900}]);
    expect(detectConflictingFacts([o])).toEqual([]);
  });
  it("never flags several employees' different wages as one conflicting fact",()=>{
    const o=recordObservation("r1","p3.labor.employee_wages.v1",
      [{employeeId:"don",defaultHourlyWageCents:1800},{employeeId:"ava",defaultHourlyWageCents:2000}]);
    expect(detectConflictingFacts([o])).toEqual([]);
  });
  it("flags genuinely different values for the SAME entity's field across two separate reads",()=>{
    const first=recordObservation("r1","p3.labor.employee_wages.v1",{employeeId:"don",defaultHourlyWageCents:1800});
    const second=recordObservation("r2","p3.labor.employee_wages.v1",{employeeId:"don",defaultHourlyWageCents:2200});
    const conflicts=detectConflictingFacts([first,second]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].values.map(v=>v.id).sort()).toEqual(["r1","r2"]);
  });
  it("never flags two different employees' single-record wage reads as conflicting",()=>{
    const don=recordObservation("r1","p3.labor.employee_wages.v1",{employeeId:"don",defaultHourlyWageCents:1800});
    const ava=recordObservation("r2","p3.labor.employee_wages.v1",{employeeId:"ava",defaultHourlyWageCents:2000});
    expect(detectConflictingFacts([don,ava])).toEqual([]);
  });
  it("does not conflate two distinct schedule weeks, including nested request selectors",()=>{
    const monday=recordObservation("r1","p3.olivia.schedule.preview",
      [{loadedLaborCostCents:10000}],{week:"2026-10-19"});
    const nextWeek=recordObservation("r2","p3.olivia.schedule.preview",
      [{loadedLaborCostCents:20000}],{request:{week:"2026-10-26"}});
    expect(detectConflictingFacts([monday,nextWeek])).toEqual([]);
  });
  it("still detects a genuine conflict for the same schedule week",()=>{
    const first=recordObservation("r1","p3.olivia.schedule.preview",
      [{loadedLaborCostCents:10000}],{week:"2026-10-19"});
    const second=recordObservation("r2","p3.olivia.schedule.preview",
      [{loadedLaborCostCents:20000}],{request:{week:"2026-10-19"}});
    expect(detectConflictingFacts([first,second])).toHaveLength(1);
  });
  it("does not flag distinct source months for derived dataset totals",()=>{
    const source1=recordObservation("r1","p3.money.expense_entries.v1",
      [{id:"one",amountCents:1000}],{period:{from:"2026-09-01",to:"2026-09-30"}});
    const source2=recordObservation("r2","p3.money.expense_entries.v1",
      [{id:"two",amountCents:2000}],{period:{from:"2026-10-01",to:"2026-10-31"}});
    const analyzed=(id:string,sourceReadId:string,value:number):Observation=>{
      const result={id:"platform.dataset.analysis",status:"partial",
        value:{groups:[{group:null,value}],unit:"USD_cents",sourceReadId}};
      const displayed=observationDisplay(result,"en");
      return {id,capabilityId:"p3.platform.dataset.analysis.v1",input:{readId:sourceReadId},result,
        reference:null,display:displayed.display,displayKind:displayed.kind,displayRaw:displayed.raw};
    };
    const first=analyzed("r3","r1",1000);
    const second=analyzed("r4","r2",2000);
    expect(detectConflictingFacts([source1,source2,first,second])).toEqual([]);
    expect(detectConflictingFacts([source1,first,analyzed("r5","r1",2200)])).toHaveLength(1);
  });
  it("separates derived analyses by source, operation, field and filter selector",()=>{
    const period={period:{from:"2026-10-01",to:"2026-10-31"}};
    const base1=recordObservation("r1","p3.money.expense_entries.v1",[],period);
    const base2=recordObservation("r2","p3.money.expense_entries.v1",[],period);
    const analysis=(id:string,sourceReadId:string,operation:string,field:string,filters:unknown[],v:number):Observation=>{
      const result={id:"platform.dataset.analysis",status:"partial",
        value:{groups:[{group:null,value:v}],unit:"USD_cents",sourceReadId,operation,field}};
      const display=observationDisplay(result,"en");
      return {id,capabilityId:"p3.platform.dataset.analysis.v1",
        input:{readId:sourceReadId,purpose:"dataset_analysis",operation,field,filters},
        result,reference:null,display:display.display,displayKind:display.kind,displayRaw:display.raw};
    };
    const sum=analysis("r3","r1","sum","amountCents",[],1000);
    const max=analysis("r4","r1","max","amountCents",[],600);
    const differentField=analysis("r5","r1","sum","otherCents",[],300);
    const differentFilter=analysis("r6","r1","sum","amountCents",[{field:"categoryCode",value:"rent"}],500);
    const differentRead=analysis("r7","r2","sum","amountCents",[],2000);
    expect(detectConflictingFacts([base1,base2,sum,max,differentField,differentFilter,differentRead])).toEqual([]);
    const changed=analysis("r8","r1","sum","amountCents",[],1400);
    expect(detectConflictingFacts([base1,sum,changed])).toHaveLength(1);
  });
  it("compares derived grouped totals by group label, regardless of output order",()=>{
    const source=recordObservation("r1","p3.money.expense_entries.v1",
      [{id:"a",amountCents:100},{id:"b",amountCents:200}],{period:{from:"2026-10-01",to:"2026-10-31"}});
    const analyzed=(id:string,groups:{group:string;value:number}[]):Observation=>{
      const result={id:"platform.dataset.analysis",status:"partial",
        value:{groups,unit:"USD_cents",sourceReadId:"r1"}};
      const displayed=observationDisplay(result,"en");
      return {id,capabilityId:"p3.platform.dataset.analysis.v1",input:{
        readId:"r1",purpose:"dataset_analysis",operation:"sum",field:"amountCents",groupBy:"category",filters:[]},
        result,reference:null,display:displayed.display,displayKind:displayed.kind,displayRaw:displayed.raw};
    };
    const first=analyzed("r2",[{group:"milk",value:100},{group:"coffee",value:200}]);
    const sameReordered=analyzed("r3",[{group:"coffee",value:200},{group:"milk",value:100}]);
    expect(detectConflictingFacts([source,first,sameReordered])).toEqual([]);
    const changed=analyzed("r4",[{group:"coffee",value:200},{group:"milk",value:150}]);
    const conflicts=detectConflictingFacts([source,first,changed]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].values.map(v=>v.id).sort()).toEqual(["r2","r4"]);
  });
  it("treats reordered AND-filters as equivalent but distinct filters as separate analyses",()=>{
    const source=recordObservation("r1","p3.money.expense_entries.v1",
      [{id:"a",amountCents:100}],{period:{from:"2026-10-01",to:"2026-10-31"}});
    const a={field:"category",operator:"eq",value:"supplies"};
    const b={field:"status",operator:"eq",value:"actual"};
    const analyzed=(id:string,filters:object[],value:number):Observation=>{
      const result={id:"platform.dataset.analysis",status:"partial",
        value:{groups:[{group:null,value}],unit:"USD_cents",sourceReadId:"r1"}};
      const displayed=observationDisplay(result,"en");
      return {id,capabilityId:"p3.platform.dataset.analysis.v1",input:{
        readId:"r1",purpose:"dataset_analysis",operation:"sum",field:"amountCents",groupBy:null,filters},
        result,reference:null,display:displayed.display,displayKind:displayed.kind,displayRaw:displayed.raw};
    };
    expect(detectConflictingFacts([source,analyzed("r2",[a,b],100),analyzed("r3",[b,a],200)])).toHaveLength(1);
    expect(detectConflictingFacts([source,analyzed("r2",[a,b],100),analyzed("r3",[a],200)])).toEqual([]);
  });
  it("still groups the SAME entity read at different array positions in two reordered/filtered reads as one conflict (Codex finding, array position vs stable id)",()=>{
    const first=recordObservation("r1","p3.labor.employee_wages.v1",
      [{employeeId:"don",defaultHourlyWageCents:1800},{employeeId:"ava",defaultHourlyWageCents:2000}]);
    // Reordered: don is now at index 1, not index 0 -- the record's own
    // stable id (employeeId) is unchanged, only its array POSITION differs.
    const second=recordObservation("r2","p3.labor.employee_wages.v1",
      [{employeeId:"ava",defaultHourlyWageCents:2000},{employeeId:"don",defaultHourlyWageCents:2200}]);
    const conflicts=detectConflictingFacts([first,second]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].values.map(v=>v.id).sort()).toEqual(["r1","r2"]);
  });
});

describe("canonical source operands and native concurrent reads",()=>{
  it("dispatches independent native P1 calls in parallel in one model round",async()=>{
    const prior=p1.getMockImplementation()!;
    let active=0,overlap=false;
    p1.mockImplementation(async(a,b,c)=>{
      active++;
      if(active>1)overlap=true;
      await new Promise<void>(resolve=>setTimeout(resolve,2));
      const output=await prior(a,b,c);
      active--;
      return output;
    });
    let steps=0;
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_review")
        return response({supported:true,complete:true,reason:"Both observations support the quoted facts."});
      expect(body.text.format.name).toBe("supervisor_investigation_step");
      if(steps++===0){
        expect(body.parallel_tool_calls).toBe(true);
        return new Response(JSON.stringify({status:"completed",
          usage:{input_tokens:10,output_tokens:10},output:[
            {type:"function_call",call_id:"a",name:capabilityToolName("p3.menu.catalog.v1"),
              arguments:JSON.stringify(query("menu.catalog"))},
            {type:"function_call",call_id:"b",name:capabilityToolName("p3.labor.employee_wages.v1"),
              arguments:JSON.stringify(query("labor.employee_wages"))}]}));
      }
      const context=JSON.parse(body.input[0].content);
      expect(context.observations).toHaveLength(2);
      expect(context.observations.map((v:{id:string})=>v.id)).toEqual(["r1","r2"]);
      return response(answer([{kind:"evidence",
        text:"The listed latte price is {{r1:value.0.priceCents}} and the recorded hourly wage is {{r2:value.0.defaultHourlyWageCents}}.",
        citations:["r1","r2"]}]));
    });
    const result=await runSupervisorTurn({...base,text:"Compare my Iced Latte price with hourly wages."},transport);
    expect(overlap).toBe(true);
    expect(p1).toHaveBeenCalledTimes(2);
    expect(result.usage.toolCallCount).toBe(2);
    expect(result.usage.modelCallCount).toBe(3);
    expect(result.reply.status).not.toBe("unavailable");
  });

  it("preflights every sibling and dispatches none when one schema is invalid",async()=>{
    let steps=0;
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_review")
        return response({supported:true,complete:true,reason:"Clarification is safe."});
      if(steps++===0)return new Response(JSON.stringify({status:"completed",
        usage:{input_tokens:10,output_tokens:10},output:[
          {type:"function_call",call_id:"a",name:capabilityToolName("p3.menu.catalog.v1"),
            arguments:JSON.stringify(query("menu.catalog"))},
          {type:"function_call",call_id:"b",name:capabilityToolName("p3.labor.employee_wages.v1"),
            arguments:JSON.stringify({...query("labor.employee_wages"),unknownProperty:"forbidden"})}]}));
      return response(answer([{kind:"clarification",
        text:"Which product and staffing comparison should I investigate?",citations:[]}]));
    });
    const result=await runSupervisorTurn({...base,
      text:"Compare my menu and worker wages."},transport);
    expect(p1).not.toHaveBeenCalled();
    expect(result.usage.toolCallCount).toBe(0);
  });

  it("rejects a parallel batch of semantically identical selectors with reversed date keys",async()=>{
    const periodA={from:"2026-10-01",to:"2026-10-15"};
    const periodB={to:"2026-10-15",from:"2026-10-01"};
    const first=query("money.expense_entries",{period:periodA});
    const second={period:periodB,purpose:first.purpose,version:1,id:"money.expense_entries"};
    let steps=0;
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));
      if(body.text.format.name==="supervisor_investigation_review")
        return response({supported:true,complete:true,reason:"A clarification is safe."});
      if(steps++===0)return new Response(JSON.stringify({status:"completed",
        usage:{input_tokens:10,output_tokens:10},output:[
          {type:"function_call",call_id:"a",name:capabilityToolName("p3.money.expense_entries.v1"),
            arguments:JSON.stringify(first)},
          {type:"function_call",call_id:"b",name:capabilityToolName("p3.money.expense_entries.v1"),
            arguments:JSON.stringify(second)}]}));
      return response(answer([{kind:"clarification",
        text:"Which expense breakdown should I review?",citations:[]}]));
    });
    const result=await runSupervisorTurn({...base,
      text:"Review my spending from October 1 through October 15."},transport);
    expect(p1).not.toHaveBeenCalled();
    expect(result.usage.toolCallCount).toBe(0);
  });

  it("rejects serial repeats even when equivalent JSON keys arrive in another order",async()=>{
    const initial=query("menu.catalog");
    const reordered={purpose:initial.purpose,version:1,id:"menu.catalog"};
    const result=await runSupervisorTurn({...base,text:"What is my Iced Latte price?"},
      transportFor([
        read("p3.menu.catalog.v1",initial),
        read("p3.menu.catalog.v1",reordered),
        answer([{kind:"evidence",text:"The recorded listed price is {{r1:value.0.priceCents}}.",
          citations:["r1"]}]),
      ]));
    expect(p1).toHaveBeenCalledTimes(1);
    expect(result.usage.toolCallCount).toBe(1);
    expect(JSON.stringify(result.reply.blocks)).toContain("$5.25");
  });

  it("uses the structured monthly-bills read as a snapshot-backed cents calculator operand",async()=>{
    const original=p1.getMockImplementation()!;
    p1.mockImplementation(async(a,b,c)=>{
      const requested=c as {id?:string};
      if(requested.id==="money.monthly_bills")
        return envelope(c as Record<string,unknown>,{totalCents:746700}) as Awaited<ReturnType<typeof executeP1Authorized>>;
      return original(a,b,c);
    });
    const recurring={...snapshot,sources:{...snapshot.sources,
      recurringCosts:[{id:"a0000000-0000-4000-8000-000000000888",label:"Monthly bills",
        amount_cents:746700,frequency:"monthly" as const,is_estimate:false,
        active_from:"2026-01-01",active_to:null}]}};
    atomic.mockResolvedValue({status:"available",snapshot:recurring});
    const handle="money.monthly_bills:value:totalCents";
    const plan={capabilityId:EXPRESSION_ID,version:1,
      purpose:"preauthorized_operands",description:"Read the verified monthly total as an authorized cents operand.",
      nodes:[{op:"source",handle}]};
    const transport=transportFor([
      read("p3.money.monthly_bills.v1",query("money.monthly_bills")),
      calculate(plan),
      answer([{kind:"evidence",text:"The monthly recurring amount is {{r2:value}}.",citations:["r2"]}]),
    ],(ctx,step)=>{
      expect((ctx.capabilities as {id:string}[]).some(x=>x.id==="p3.money.recurring_monthly_bills_cents.v1")).toBe(false);
      if(step===1)
        expect(ctx.authorizedOperands).toEqual(expect.arrayContaining([
          expect.objectContaining({handle,unit:"USD_cents"})]));
    });
    const result=await runSupervisorTurn({...base,text:"What is my recorded recurring monthly total?"},transport);
    expect(p1).toHaveBeenCalledTimes(1);
    expect(result.usage.toolCallCount).toBe(2);
    expect(JSON.stringify(result.reply.blocks)).toContain("$7,467.00");
  });
});
