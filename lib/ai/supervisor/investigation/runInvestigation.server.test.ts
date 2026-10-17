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
function transportFor(steps:unknown[],inspect?:(context:Record<string,unknown>,step:number)=>void){
  let next=0;
  return vi.fn(async(_url:string,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
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
    const transport=transportFor([read("p3.public.research.v1",{purpose:"public_market_research",query:"nearby cafe menu prices"}),
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
      read("p3.public.research.v1",{purpose:"public_market_research",query:"nearby cafe menu prices"}),
      answer([{kind:"evidence",text:"This public menu is a lead: {{r1:value.0.url}}. Confirm the current size and price before comparing it with your own menu.",citations:["r1"]}])]));
    expect(result.reply.blocks.some(b=>b.type==="warning"&&b.code==="SUPERVISOR_PUBLIC_RESEARCH")).toBe(true);
    expect(JSON.stringify(result.reply.blocks)).toContain("https://example.com/menu");
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

  it("bounds provider failures and does not fabricate a clarification about dates",async()=>{
    const transport=vi.fn(async()=>new Response("down",{status:503}));
    const onUsage=vi.fn();
    await expect(runSupervisorTurn({...base,text:"Why are supplies costing more?",onUsage},transport))
      .rejects.toMatchObject({category:"provider_http",httpStatus:503});
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({modelCallCount:1}));
    expect(transport).toHaveBeenCalledTimes(1);
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
  const second=await runSupervisorTurn({...base,text:"Make her cap 90 minutes instead.",investigationMemory:first.reply.investigationMemory},transportFor([cap(90),final]));
  expect(second.reply.status).toBe("partial");
  expect(JSON.stringify(second.reply.blocks)).toContain("90 minutes");
  expect(olivia).toHaveBeenLastCalledWith(expect.objectContaining({capability:"olivia.schedule.whatIf",
    overrides:[expect.objectContaining({employeeId:employee,maxWeeklyMinutes:90})]}));
});

it("blocks private staff terms from being sent to external research",async()=>{
  vi.mocked(researchEnabled).mockReturnValue(true);
  const result=await runSupervisorTurn({...base,text:"Compare local competitor prices."},transportFor([
    read("p3.labor.employee_wages.v1",query("labor.employee_wages")),
    read("p3.public.research.v1",{purpose:"public_market_research",query:"Sophie wages 1800"}),
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

it("enforces a bounded investigation even when the model repeatedly chooses invalid tools",async()=>{
  const transport=vi.fn(async()=>response(read("execute_sql",{sql:"select 1"})));
  const result=await runSupervisorTurn({...base,text:"Investigate everything."},transport);
  expect(result.usage.toolCallCount).toBe(5);
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

it("honors the configured model-access fallback with shared bounded usage",async()=>{
  const previous=process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL;
  process.env.SUPERVISOR_OPENAI_FALLBACK_MODEL="allowed-small-model";
  try{
    const models:string[]=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));models.push(body.model);
      if(models.length===1)return new Response(JSON.stringify({error:{code:"model_not_found"}}),{status:404});
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
