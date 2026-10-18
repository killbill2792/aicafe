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
import {validateGroundedReply} from "@/lib/ai/conversations/replyValidation";
import {readers,purposePolicies,type SupportedId} from "@/lib/metrics/p1Catalog";
import type {AtomicP1SourceSnapshot} from "@/lib/metrics/p1AtomicSourceSnapshot.server";
import type {BusinessScopedCafeTools} from "@/lib/ai/tools";
import type {InvestigationAnswer} from "./protocol";
import {EXPRESSION_ID} from "../p3/expression";

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
const read=(capabilityId:string,args:unknown)=>({action:"read",capabilityId,argumentsJson:JSON.stringify(args),responseJson:null});
const answer=(paragraphs:InvestigationAnswer["paragraphs"])=>({action:"answer",capabilityId:null,argumentsJson:null,responseJson:JSON.stringify({paragraphs})});
function envelope(input:Record<string,unknown>,value:unknown){
  const id=input.id as SupportedId;
  return {id,version:1,query:input,status:"partial",unit:"typed_record",valueKind:"record",value,
    quality:q,completeness:"partial",actuality:"actual",provenance:{canonicalReaderId:readers[id],readerContractVersion:1,
      selectorContractId:id+".selector",selectorContractVersion:1,purpose:input.purpose,asOf,timezone:identity.timezone,sourceRevision:null},
    freshness:{asOf,capturedAt:null,stale:null}};
}
function transportFor(steps:unknown[],inspect?:(context:Record<string,unknown>,step:number)=>void,privacySafe=true){
  let next=0;
  return vi.fn(async(_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    if(body.text.format.name==="supervisor_calendar_context_review")return response({verdict:"applies"});
    if(body.text.format.name==="supervisor_public_query_review")return response({safe:privacySafe});
    if(body.text.format.name==="supervisor_investigation_review")return response({supported:true,complete:true});
    expect(body.text.format.name).toBe("supervisor_investigation_step");
    inspect?.(JSON.parse(body.input[0].content),next);
    return response(steps[next++]??answer([{kind:"clarification",text:"Which remaining option should I investigate?",citations:[]}]))});
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
      {action:"calculate",capabilityId:EXPRESSION_ID,argumentsJson:JSON.stringify(plan),responseJson:null},
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
      {action:"calculate",capabilityId:EXPRESSION_ID,argumentsJson:JSON.stringify({
        capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",
        description:"Direct observed menu-price operand",nodes:[{op:"source",handle:`menu.product_economics:${product}:priceCents`}]
      }),responseJson:null},
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
        expect(request.text.format.schema.properties.action.enum).toEqual(["answer"]);
        expect(request.text.format.schema.properties.capabilityId.type).toBe("null");
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

it("reserves extra calendar-gate time when a failed owner correction may require review",async()=>{
  const realNow=Date.now();
  let clock=realNow;
  const now=vi.spyOn(Date,"now").mockImplementation(()=>clock);
  try{
    const memory={version:1 as const,businessId:cafe,ownerStatements:["Show the saved menu."],reads:[]};
    const history=[{role:"owner",text:"Show the saved menu."},
      {role:"owner",text:"Actually use 2026-10-12 instead."}];
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

it("never publishes an unsupported answer rejected by the independent evidence review",async()=>{
  const transport=vi.fn(async(_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    return body.text.format.name==="supervisor_investigation_review"?response({supported:false,complete:false}):
      response(answer([{kind:"advice",text:"I have secretly published the schedule.",citations:[]}]))});
  const result=await runSupervisorTurn({...base,text:"Can you inspect scheduling options?"},transport);
  expect(result.reply.status).toBe("unavailable");
  expect(JSON.stringify(result.reply.blocks)).not.toContain("secretly");
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
      return body.text.format.name==="supervisor_investigation_review"?response({supported:true,complete:true}):
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
    {action:"calculate",capabilityId:EXPRESSION_ID,argumentsJson:JSON.stringify({capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",
      description:"Recorded hourly rate mean, excluding salary conversion",nodes:[{op:"source",handle:"dataset:r2:0"},{op:"source",handle:"dataset:r3:0"},{op:"divide"}]}),responseJson:null},
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
    {action:"calculate",capabilityId:EXPRESSION_ID,argumentsJson:JSON.stringify({capabilityId:EXPRESSION_ID,
      version:1,purpose:"no_external_sources",description:"Owner hypothetical product price",
      nodes:[{op:"hypothetical",label:"product price",quotedNumber:"5",value:500,unit:"USD_cents"}]}),responseJson:null},
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
    {action:"calculate",capabilityId:EXPRESSION_ID,argumentsJson:JSON.stringify({capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",description:"Count of returned public leads, not verified suppliers",nodes:[{op:"source",handle:"dataset:r2:0"}]}),responseJson:null},
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
