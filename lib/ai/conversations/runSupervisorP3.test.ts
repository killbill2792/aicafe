import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { runSupervisorTurn } from "./runSupervisorTurn.server";
import { validateGroundedReply } from "./replyValidation";
import { EXPRESSION_ID } from "@/lib/ai/supervisor/p3/expression";
import { verifiedReaderPeriods } from "@/lib/ai/supervisor/p3/runP3Turn.server";
import { projectP1Evidence } from "@/lib/ai/supervisor/p3/operandProjection.server";
import { readers,type SupportedId } from "@/lib/metrics/p1Catalog";

const identity={businessId:"cafe-test",asOf:"2026-10-15",
  timezone:"America/Los_Angeles",currency:"USD"};
const menuInput={id:"menu.catalog",version:1,purpose:"menu_catalog_review"};
const wageInput={id:"labor.employee_wages",version:1,
  purpose:"authorized_owner_wage_review"};
const productInput={id:"menu.product_economics",version:1,
  purpose:"current_recipe_cost_review",productId:"latte"};
const quality={level:"low",missingInputs:["unversioned_source"],
  estimatedInputs:[],staleInputs:[]};
const menu=[{id:"latte",name:"latte",category:"drink",
  active:true,priceCents:525,priceStatus:"recorded"}];
const workers=[{id:"sophie",name:"Sophie",role:"barista",active:true,
  defaultHourlyWageCents:1800,wagePeriod:"hour",wageAmountCents:1800,
  wageKnown:true,wageProvenance:"recorded_positive"}];
const economics={id:"latte",name:"latte",category:"drink",active:true,
  priceCents:525,prepSeconds:85,ingredientsCentsToday:125,hasRecipe:true,
  costStatus:"READY",costSource:"recipe",recipeCostCents:125,
  recipeCostStatus:"READY",ownerTotalCostCents:null,costDifferenceCents:null,
  costQuality:"actual",quantitySoldLast28Days:10};
const result=(input:{id:string;version:number;purpose:string},value:unknown)=>({
  id:input.id,version:1,query:input,unit:"typed_record",valueKind:"record",
  status:"partial",completeness:"partial",actuality:"actual",
  value,quality,provenance:{
    canonicalReaderId:input.id==="menu.catalog"?"readP1MenuCatalog":
      input.id==="menu.product_economics"?"getProductEconomics":"readP1EmployeeWages",readerContractVersion:1,
    selectorContractId:input.id+".selector",selectorContractVersion:1,
    purpose:input.purpose,asOf:identity.asOf,timezone:identity.timezone,
    sourceRevision:null,
  },
  freshness:{asOf:identity.asOf,capturedAt:null,stale:null},
});
const p1Reads=vi.hoisted(()=>vi.fn());
const p1Auth=vi.hoisted(()=>vi.fn());
vi.mock("@/lib/metrics/p1Readers.server",async(importOriginal)=>{
  const original=await importOriginal<typeof import("@/lib/metrics/p1Readers.server")>();
  return {...original,authorizedOwnerP1:p1Auth,executeP1Authorized:p1Reads};
});
const firstClause="Sell 25 more lattes";
const secondClause="Sophie works 45 more minutes";
const goal=firstClause+" and "+secondClause;
const compositionPlan={
  capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",
  description:"Extra revenue less paid labor cost, excluding unknown ingredients",
  nodes:[
    {op:"source",handle:"menu.product_economics:latte:priceCents"},
    {op:"source",handle:"menu.product_economics:latte:ingredientsCentsToday"},
    {op:"subtract"},
    {op:"hypothetical",label:"additional lattes",quotedNumber:"25",value:25,unit:"item"},
    {op:"multiply"},
    {op:"source",handle:"labor.employee_wages:sophie:defaultHourlyWageCents"},
    {op:"hypothetical",label:"extra paid minutes",quotedNumber:"45",value:45,unit:"minute"},
    {op:"multiply"},{op:"scenario_delta"},
  ],
};
const response=(v:unknown)=>new Response(JSON.stringify({
  model:"p3-fixture",status:"completed",
  usage:{input_tokens:25,output_tokens:10},
  output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(v)}]}],
}),{status:200,headers:{"content-type":"application/json"}});
const makeTransport=(opts:{tamper?:boolean;providerFailure?:boolean}={})=>{
  const requests:Array<Record<string,unknown>>=[];
  const calls=vi.fn(async (_url:string,init:RequestInit)=>{
    const message=JSON.parse(init.body as string) as Record<string,unknown>;
    requests.push(message);
    if(opts.providerFailure)return new Response("unavailable",{status:503});
    if(requests.length===1)
      return response({complete:true,clauses:[firstClause,secondClause]});
    if(requests.length===2)
      return response({complete:true,choices:[
        {clause:firstClause,capabilityId:"p3.menu.catalog.v1",
          inputJson:JSON.stringify(menuInput),reason:null},
        {clause:secondClause,capabilityId:"p3.labor.employee_wages.v1",
          inputJson:JSON.stringify(wageInput),reason:null},
      ]});
    return response({complete:true,plans:[{
      coveredClauses:[firstClause,secondClause],
      planJson:JSON.stringify(opts.tamper?{
        ...compositionPlan,nodes:[{op:"source",handle:"other-tenant:wage"}],
      }:compositionPlan),reason:null,
    }]});
  });
  return {calls,requests};
};
const run=(transport:ReturnType<typeof makeTransport>["calls"],
  question:string=goal,locale:"en"|"es"|"ar"="en",
  history:Array<{role:"owner"|"supervisor";text:string}>=[])=>
  runSupervisorTurn({
    text:question,locale,asOf:identity.asOf,timezone:identity.timezone,
    cafeName:"Fixture Cafe",history,
    tools:{} as BusinessScopedCafeTools,readRules:async()=>[],
  },transport);

describe("COMPOSE end-to-end compatibility-flagged Supervisor",()=>{
  beforeEach(()=>{
    vi.stubEnv("OPENAI_API_KEY","fixture-not-live");
    vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
    vi.stubEnv("SUPERVISOR_P3_COMPOSITION_ENABLED","true");
    vi.stubEnv("SUPERVISOR_P3_ALLOWED_BUSINESS_IDS",identity.businessId);
    p1Auth.mockReset().mockResolvedValue({identity,tools:{} as BusinessScopedCafeTools});
    p1Reads.mockReset().mockImplementation(async(_tools:unknown,_identity:unknown,raw:unknown)=>{
      const id=(raw as {id:SupportedId}).id;
      if(id==="menu.catalog")return result(menuInput,menu);
      if(id==="labor.employee_wages")return result(wageInput,workers);
      if(id==="menu.product_economics")return result(productInput,economics);
      throw Error("Unsupported fixture source");
    });
  });
  afterEach(()=>vi.unstubAllEnvs());
  it("COMPOSE-02: a single owner clause safely selects wages AND employer burden",async()=>{
    const clause="Sophie works 45 extra minutes including employer burden";
    const burden={id:"labor.payroll_burden",version:1,
      purpose:"authorized_owner_employer_cost_review"};
    p1Reads.mockImplementation(async(_tools:unknown,_identity:unknown,raw:unknown)=>{
      const key=(raw as {id:string}).id;
      if(key==="labor.employee_wages")return result(wageInput,workers);
      if(key==="labor.payroll_burden"){
        const envelope=result(burden,{
          rateBasisPoints:1200,status:"confirmed",source:"owner_confirmed"});
        return {...envelope,provenance:{...envelope.provenance,
          canonicalReaderId:readers["labor.payroll_burden"]}};
      }
      throw Error("unauthorized extra read");
    });
    let step=0;
    const provider=vi.fn(async()=>{
      const n=step++;
      if(n===0)return response({complete:true,clauses:[clause]});
      if(n===1)return response({complete:true,choices:[
        {clause,capabilityId:"p3.labor.employee_wages.v1",
          inputJson:JSON.stringify(wageInput),reason:null},
        {clause,capabilityId:"p3.labor.payroll_burden.v1",
          inputJson:JSON.stringify(burden),reason:null},
      ]});
      return response({complete:true,plans:[{
        coveredClauses:[clause],reason:null,planJson:JSON.stringify({
          capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",
          description:"Canonical wage plus recorded employer burden",
          nodes:[
            {op:"source",handle:"labor.employee_wages:sophie:defaultHourlyWageCents"},
            {op:"hypothetical",label:"paid minutes",quotedNumber:"45",value:45,
              unit:"minute"},
            {op:"multiply"},
            {op:"source",handle:"labor.payroll_burden:aggregate:rateBasisPoints"},
            {op:"loaded_labor"},
          ],
        }),
      }]});
    });
    const output=await run(provider,clause);
    expect(output.reply.status).toBe("partial");
    expect(output.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"metric",valueCents:1512}),
    ]));
    expect(output.usage).toMatchObject({modelCallCount:3,toolCallCount:3});
    expect(p1Reads).toHaveBeenCalledTimes(2);
  });
  it("COMPOSE-01/07: calculates loaded labor via an authorized employer-rate read, not model tax",async()=>{
    const clauses=["Sophie works 45 more minutes","show employer payroll burden"];
    const request=clauses.join(" and ");
    const burdenInput={id:"labor.payroll_burden",version:1,
      purpose:"authorized_owner_employer_cost_review"};
    const rate={rateBasisPoints:1200,status:"confirmed",source:"owner_confirmed"};
    p1Reads.mockImplementation(async(_tools:unknown,_identity:unknown,raw:unknown)=>{
      const choice=raw as {id:string};
      if(choice.id==="labor.employee_wages")return result(wageInput,workers);
      if(choice.id==="labor.payroll_burden"){
        const base=result(burdenInput,rate);
        return {...base,provenance:{...base.provenance,
          canonicalReaderId:readers["labor.payroll_burden"]}};
      }
      throw Error("unexpected read");
    });
    let step=0;
    const transport=vi.fn(async()=>{
      const n=step++;
      if(n===0)return response({complete:true,clauses});
      if(n===1)return response({complete:true,choices:[
        {clause:clauses[0],capabilityId:"p3.labor.employee_wages.v1",
          inputJson:JSON.stringify(wageInput),reason:null},
        {clause:clauses[1],capabilityId:"p3.labor.payroll_burden.v1",
          inputJson:JSON.stringify(burdenInput),reason:null},
      ]});
      return response({complete:true,plans:[{
        coveredClauses:clauses,reason:null,planJson:JSON.stringify({
          capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",
          description:"Hourly wage times paid minutes plus authorized employer burden",
          nodes:[
            {op:"source",handle:"labor.employee_wages:sophie:defaultHourlyWageCents"},
            {op:"hypothetical",label:"extra paid minutes",quotedNumber:"45",
              value:45,unit:"minute"},
            {op:"multiply"},
            {op:"source",handle:"labor.payroll_burden:aggregate:rateBasisPoints"},
            {op:"loaded_labor"},
          ],
        }),
      }]});
    });
    const output=await run(transport,request);
    expect(output.reply.status).toBe("partial");
    expect(output.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"metric",valueCents:1512}),
      expect.objectContaining({type:"warning",code:"P3_BASELINE"}),
    ]));
    expect(output.usage).toMatchObject({modelCallCount:3,toolCallCount:3});
    expect(p1Reads).toHaveBeenCalledTimes(2);
  });
  it("COMPOSE-01: item contribution minus canonical loaded paid minutes uses five or fewer operations",async()=>{
    const clauses=["Sell 25 more lattes","Sophie works 45 more minutes",
      "show employer payroll burden"];
    const question=clauses.join(" and ");
    const burdenInput={id:"labor.payroll_burden",version:1,
      purpose:"authorized_owner_employer_cost_review"};
    p1Reads.mockImplementation(async(_tools:unknown,_identity:unknown,raw:unknown)=>{
      const id=(raw as {id:string}).id;
      if(id==="menu.catalog")return result(menuInput,menu);
      if(id==="menu.product_economics")return result(productInput,economics);
      if(id==="labor.employee_wages")return result(wageInput,workers);
      if(id==="labor.payroll_burden"){
        const base=result(burdenInput,{
          rateBasisPoints:1200,status:"confirmed",source:"owner_confirmed"});
        return {...base,provenance:{...base.provenance,
          canonicalReaderId:readers["labor.payroll_burden"]}};
      }
      throw Error("unexpected source");
    });
    const nodes=[
      {op:"source",handle:"menu.product_economics:latte:priceCents"},
      {op:"source",handle:"menu.product_economics:latte:ingredientsCentsToday"},
      {op:"subtract"},
      {op:"hypothetical",label:"extra drinks",quotedNumber:"25",value:25,unit:"item"},
      {op:"multiply"},
      {op:"source",handle:"labor.employee_wages:sophie:defaultHourlyWageCents"},
      {op:"hypothetical",label:"paid minutes",quotedNumber:"45",value:45,unit:"minute"},
      {op:"multiply"},
      {op:"source",handle:"labor.payroll_burden:aggregate:rateBasisPoints"},
      {op:"loaded_labor"},{op:"scenario_delta"},
    ];
    let step=0;
    const provider=vi.fn(async()=>{
      const phase=step++;
      if(phase===0)return response({complete:true,clauses});
      if(phase===1)return response({complete:true,choices:[
        {clause:clauses[0],capabilityId:"p3.menu.catalog.v1",
          inputJson:JSON.stringify(menuInput),reason:null},
        {clause:clauses[1],capabilityId:"p3.labor.employee_wages.v1",
          inputJson:JSON.stringify(wageInput),reason:null},
        {clause:clauses[2],capabilityId:"p3.labor.payroll_burden.v1",
          inputJson:JSON.stringify(burdenInput),reason:null},
      ]});
      return response({complete:true,plans:[{
        coveredClauses:clauses,reason:null,planJson:JSON.stringify({
          capabilityId:EXPRESSION_ID,version:1,
          purpose:"preauthorized_operands",
          description:"Extra gross contribution less loaded paid labor, without unrelated net-profit claims",
          nodes,
        }),
      }]});
    });
    const output=await run(provider,question);
    expect(output.reply.status).toBe("partial");
    expect(output.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"metric",valueCents:8488}),
      expect.objectContaining({type:"warning",code:"P3_SOURCE_LIMITATIONS"}),
    ]));
    expect(output.usage).toMatchObject({modelCallCount:3,toolCallCount:5});
    expect(p1Reads).toHaveBeenCalledTimes(4);
    expect(output.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"warning",code:"P3_CONDITIONAL"}),
      expect.objectContaining({type:"warning",code:"P3_BASELINE"}),
    ]));
  });
  it("does not invent a payroll burden when no canonical payroll rate is available",async()=>{
    const clauses=["Sophie works 45 more minutes","show employer payroll burden"];
    const request=clauses.join(" and ");
    const burdenInput={id:"labor.payroll_burden",version:1,
      purpose:"authorized_owner_employer_cost_review"};
    p1Reads.mockImplementation(async(_tools:unknown,_identity:unknown,raw:unknown)=>{
      const choice=raw as {id:string};
      return choice.id==="labor.employee_wages"?result(wageInput,workers):
        {status:"unavailable",value:null,reason:"unavailable_source"};
    });
    let step=0;
    const provider=vi.fn(async()=>{
      const n=step++;
      if(n===0)return response({complete:true,clauses});
      if(n===1)return response({complete:true,choices:[
        {clause:clauses[0],capabilityId:"p3.labor.employee_wages.v1",
          inputJson:JSON.stringify(wageInput),reason:null},
        {clause:clauses[1],capabilityId:"p3.labor.payroll_burden.v1",
          inputJson:JSON.stringify(burdenInput),reason:null},
      ]});
      return response({complete:true,plans:[{coveredClauses:clauses,
        planJson:null,reason:"missing_input"}]});
    });
    const output=await run(provider,request);
    expect(output.reply.status).toBe("unavailable");
    expect(output.reply.blocks.some(b=>b.type==="metric")).toBe(false);
    expect(p1Reads).toHaveBeenCalledTimes(2);
  });
  it("COMPOSE-01/02/03/04: uses previously unseen model expression, both P1 source domains and exact cents",async()=>{
    const transport=makeTransport();
    const outcome=await run(transport.calls);
    expect(outcome.reply.status).toBe("partial");
    expect(outcome.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"metric",valueCents:8650}),
      expect.objectContaining({type:"warning",code:"P3_CONDITIONAL"}),
    ]));
    expect(outcome.reply.blocks).not.toContainEqual(expect.objectContaining({
      type:"task_card",
    }));
    expect(outcome.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"warning",code:"P3_BASELINE"}),
      expect.objectContaining({type:"warning",code:"P3_SOURCE_LIMITATIONS"}),
      expect.objectContaining({type:"text",text:expect.stringContaining("Vetted calculation steps")}),
      expect.objectContaining({type:"text",text:expect.stringContaining("Owner-stated hypothetical")}),
    ]));
    expect(p1Reads).toHaveBeenCalledTimes(3);
    expect(outcome.usage).toMatchObject({modelCallCount:3,toolCallCount:4});
    expect(transport.requests.every(req=>req.store===false)).toBe(true);
    expect(transport.requests.every(req=>!JSON.stringify(req).includes("525")))
      .toBe(true);
    const submitted=(transport.requests[2].input as Array<{content:string}>)[0].content;
    const ownerChoices=(JSON.parse(submitted) as {authorizedOperandChoices:Array<{
      handle:string;entityName:string;entityId:string;matchedClause:string;
    }>}).authorizedOperandChoices;
    expect(ownerChoices).toEqual(expect.arrayContaining([
      expect.objectContaining({handle:"labor.employee_wages:sophie:defaultHourlyWageCents",
        entityName:"Sophie",entityId:"sophie",matchedClause:secondClause}),
      expect.objectContaining({handle:"menu.product_economics:latte:priceCents",
        entityName:"latte",entityId:"latte",matchedClause:firstClause}),
    ]));
  });
  it.each([
    {field:"id",value:"unrelated-product"},
    {field:"name",value:"unrelated product"},
  ])("rejects product-economics enrichment when canonical $field differs from the selected menu product",async({field,value})=>{
    p1Reads.mockImplementation(async(_tools:unknown,_identity:unknown,raw:unknown)=>{
      const id=(raw as {id:SupportedId}).id;
      if(id==="menu.catalog")return result(menuInput,menu);
      if(id==="labor.employee_wages")return result(wageInput,workers);
      if(id==="menu.product_economics")return result(productInput,{
        ...economics,[field]:value,
      });
      throw Error("Unsupported fixture source");
    });
    const transport=makeTransport();
    await run(transport.calls).catch(()=>null);
    expect(p1Reads).toHaveBeenCalledWith(expect.anything(),expect.anything(),
      expect.objectContaining({productId:"latte"}));
    // The model must never receive pricing/cost operands from the swapped
    // economics record, even though its schema and recipe costs are valid.
    const composition=transport.requests[2];
    expect(composition).toBeDefined();
    const message=(composition.input as Array<{content:string}>)[0].content;
    const {authorizedOperandChoices}=JSON.parse(message) as {
      authorizedOperandChoices:Array<{handle:string}>;
    };
    expect(authorizedOperandChoices.some(operand=>
      operand.handle.startsWith("menu.product_economics:"))).toBe(false);
  });
  it("COMPOSE-05/06/07: forged source handle never produces a numerical fact",async()=>{
    const transport=makeTransport({tamper:true});
    // An invalid P3 plan must not be passed through as trusted numbers.
    // Legacy may be asked to perform a normal read, but cannot use the forged handle.
    const output=await run(transport.calls).catch(e=>e);
    expect(output?.reply?.blocks?.some((v:{valueCents?:number})=>v.valueCents===11775))
      .not.toBe(true);
    // Three P3 model attempts, two canonical reads, and the rejected plan's
    // bounded tool invocation stay charged. Cross-clause handle rejection
    // occurs BEFORE running any extra calculation or legacy model attempt.
    expect(transport.calls).toHaveBeenCalledTimes(3);
    expect(output?.usage).toMatchObject({modelCallCount:3,toolCallCount:3});
    expect(output?.reply).toMatchObject({status:"unavailable"});
    expect(output?.reply?.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"warning",code:"SUPERVISOR_TURN_BUDGET"}),
    ]));
  });
  it("never exceeds the three-call model budget on a legacy retry after P3",async()=>{
    const question="How much would this cost?";
    let calls=0;
    const transport=vi.fn(async()=>{
      calls++;
      if(calls===1)return response({complete:true,clauses:[question]});
      if(calls===2)return response({complete:false,choices:[]});
      if(calls===3)return new Response(JSON.stringify({status:"incomplete",
        model:"gpt-6-luna",usage:{input_tokens:10,output_tokens:2},output:[]}),
        {status:200});
      throw Error("Budget violation: forbidden fourth model attempt");
    });
    const output=await run(transport,question).catch(error=>error);
    expect(output).not.toHaveProperty("reply");
    expect(transport).toHaveBeenCalledTimes(3);
    expect(p1Reads).not.toHaveBeenCalled();
  });
  it("COMPOSE-08: rejects provider failure without executing domain effects",async()=>{
    const transport=makeTransport({providerFailure:true});
    const output=await run(transport.calls).catch(e=>e);
    expect(output?.reply?.blocks?.some((v:{type:string})=>v.type==="metric"))
      .not.toBe(true);
    expect(p1Reads).not.toHaveBeenCalled();
  });
  it("COMPOSE-03: compares actual recorded supplier quotes using US gallon/fluid-ounce units",async()=>{
    const quoteInput={id:"supplies.quotes",version:1,purpose:"owner_reported_quote_review"};
    const quotes={items:[
      {id:"oat-quote",supplierName:"Supplier A",itemName:"oat milk",
        priceCents:480,packageCount:1,packageUnit:"gal",
        sourceKind:"supplier_quote",sourceUrl:null,quotedOn:"2026-10-01",
        evidenceStatus:"owner_reported",createdAt:"2026-10-01T00:00:00Z"},
      {id:"whole-quote",supplierName:"Supplier B",itemName:"whole milk",
        priceCents:384,packageCount:1,packageUnit:"gal",
        sourceKind:"supplier_quote",sourceUrl:null,quotedOn:"2026-10-01",
        evidenceStatus:"owner_reported",createdAt:"2026-10-01T00:00:00Z"},
    ],truncated:false};
    p1Reads.mockImplementation(async()=>{
      return {...result(quoteInput,quotes),actuality:"unknown",provenance:{
        canonicalReaderId:"readP1SupplierQuotes",readerContractVersion:1,
        selectorContractId:"supplies.quotes.selector",selectorContractVersion:1,
        purpose:quoteInput.purpose,asOf:identity.asOf,
        timezone:identity.timezone,sourceRevision:null,
      }};
    });
    const sourceRequest="Compare oat milk and whole milk for 12 oz";
    const sections=["Compare oat milk","whole milk for 12 oz"];
    const plan={
      capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",
      description:"Compare quoted milk cost for one 12-ounce use",
      nodes:[
        {op:"source",handle:"supplies.quotes:oat-quote:pricePerGallon"},
        {op:"hypothetical",label:"oat milk ounces",quotedNumber:"12",
          value:12,unit:"US_fl_oz"},{op:"multiply"},
        {op:"source",handle:"supplies.quotes:whole-quote:pricePerGallon"},
        {op:"hypothetical",label:"whole milk ounces",quotedNumber:"12",
          value:12,unit:"US_fl_oz"},{op:"multiply"},{op:"scenario_delta"},
      ],
    };
    let step=0;
    const provider=vi.fn(async()=>response([
      {complete:true,clauses:sections},
      {complete:true,choices:sections.map(clause=>({
        clause,capabilityId:"p3.supplies.quotes.v1",
        inputJson:JSON.stringify(quoteInput),reason:null,
      }))},
      {complete:true,plans:[{coveredClauses:sections,
        planJson:JSON.stringify(plan),reason:null}]},
    ][step++]));
    const outcome=await run(provider,sourceRequest);
    expect(outcome.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"metric",valueCents:9}),
      expect.objectContaining({type:"warning",code:"P3_SOURCE_LIMITATIONS"}),
    ]));
    expect(outcome.reply.status).toBe("partial");
    expect(p1Reads).toHaveBeenCalledTimes(2);
  });
  it("never cites cafe-state evidence for pure owner-only money arithmetic",async()=>{
    const question="What is 10% of $25?";
    const phrase=[question];
    const sourceFree={capabilityId:EXPRESSION_ID,version:1,
      purpose:"no_external_sources",description:"Owner-only hypothetical percent",
      nodes:[
        {op:"hypothetical",label:"quoted dollars",quotedNumber:"25",
          value:2500,unit:"USD_cents"},
        {op:"hypothetical",label:"quoted percent",quotedNumber:"10",
          value:1000,unit:"ratio_bps"},
        {op:"multiply"},
      ],
    };
    let step=0;
    const provider=vi.fn(async()=>response([
      {complete:true,clauses:phrase},
      {complete:true,choices:[{clause:question,capabilityId:null,
        inputJson:null,reason:"source_free"}]},
      {complete:true,plans:[{coveredClauses:phrase,
        planJson:JSON.stringify(sourceFree),reason:null}]},
    ][step++]));
    const outcome=await run(provider,question);
    expect(outcome.reply.status).toBe("partial");
    expect(outcome.reply.evidence).toEqual([]);
    // This is the same mandatory gate used by persistGroundedSupervisorReply.
    expect(validateGroundedReply(outcome.reply)).toEqual(outcome.reply);
    expect(p1Reads).not.toHaveBeenCalled();
    expect(outcome.usage.toolCallCount).toBe(1);
    expect(outcome.reply.blocks.some(block=>block.type==="metric")).toBe(false);
    expect(outcome.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"text",text:expect.stringContaining("$2.50")}),
    ]));
  });
  it("evaluates a pure percentage next to a separate café-backed product read",async()=>{
    const cafeClause="Show my latte cost";
    const pureClause="calculate 10% of $25";
    const question=cafeClause+" and "+pureClause;
    const readPlan={capabilityId:EXPRESSION_ID,version:1,
      purpose:"preauthorized_operands",description:"Source-backed latte ingredient cost",
      nodes:[{op:"source",handle:"menu.product_economics:latte:ingredientsCentsToday"}]};
    const purePlan={capabilityId:EXPRESSION_ID,version:1,
      purpose:"no_external_sources",description:"Quoted owner-only 10% of 25 dollars",
      nodes:[
        {op:"hypothetical",quotedNumber:"25",value:2500,unit:"USD_cents",label:"quoted dollars"},
        {op:"hypothetical",quotedNumber:"10",value:1000,unit:"ratio_bps",label:"quoted percent"},
        {op:"multiply"},
      ]};
    let step=0;
    const provider=vi.fn(async()=>response([
      {complete:true,clauses:[cafeClause,pureClause]},
      {complete:true,choices:[
        {clause:cafeClause,capabilityId:"p3.menu.catalog.v1",
          inputJson:JSON.stringify(menuInput),reason:null},
        {clause:pureClause,capabilityId:null,inputJson:null,reason:"source_free"},
      ]},
      {complete:true,plans:[
        {coveredClauses:[cafeClause],planJson:JSON.stringify(readPlan),reason:null},
        {coveredClauses:[pureClause],planJson:JSON.stringify(purePlan),reason:null},
      ]},
    ][step++]));
    const output=await run(provider,question);
    expect(output.reply.status).toBe("partial");
    expect(output.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"text",text:expect.stringContaining("$1.25 per item")}),
      expect.objectContaining({type:"text",text:expect.stringContaining("$2.50")}),
    ]));
    expect(output.reply.evidence).toHaveLength(1);
    expect(output.usage.modelCallCount).toBe(3);
    expect(p1Reads).toHaveBeenCalled();
  });
  it("never borrows a hypothetical quantity from another audited clause",async()=>{
    const clauses=["Increase by 25 items","Increase by 30 items"];
    const question=clauses.join(" and ");
    const testPlan=(quantity:number)=>({capabilityId:EXPRESSION_ID,version:1,
      purpose:"no_external_sources",description:"Quoted item increment",
      nodes:[{op:"hypothetical",label:"additional items",
        quotedNumber:String(quantity),value:quantity,unit:"item"}],
    });
    async function scenario(borrow:boolean){
      let callNumber=0;
      const transport=vi.fn(async()=>response([
        {complete:true,clauses},
        {complete:true,choices:clauses.map(clause=>({clause,
          capabilityId:null,inputJson:null,reason:"source_free"}))},
        {complete:true,plans:clauses.map((clause,i)=>({
          coveredClauses:[clause],reason:null,
          planJson:JSON.stringify(testPlan(i===0?(borrow?30:25):30)),
        }))},
      ][callNumber++]));
      return run(transport,question);
    }
    const valid=await scenario(false);
    expect(valid.reply.status).toBe("partial");
    expect(valid.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"text",text:expect.stringContaining("25 items")}),
      expect.objectContaining({type:"text",text:expect.stringContaining("30 items")}),
    ]));
    const forged=await scenario(true);
    expect(forged.reply.status).toBe("unavailable");
    expect(forged.reply.evidence).toEqual([]);
    expect(forged.usage.modelCallCount).toBe(3);
  });
  it("preserves a content observation fingerprint without inventing a DB revision",()=>{
    const clause="Sophie works 45 extra minutes";
    const original=result(wageInput,workers);
    const hashed={...original,provenance:{
      ...original.provenance,observedContentHash:"sha256:"+"a".repeat(64)}};
    const make=(resultEnvelope:unknown)=>[{
      clause,capabilityId:"p3.labor.employee_wages.v1",
      status:"partial" as const,result:resultEnvelope,reason:null,
    }];
    const projection=projectP1Evidence(
      make(hashed),identity.businessId,clause);
    expect(projection.operands).toHaveLength(1);
    expect(projection.operands[0]).toMatchObject({
      sourceRevision:null,observedContentHash:"sha256:"+"a".repeat(64),
      status:"partial",evidenceStatus:"unverified",
    });
    expect(projectP1Evidence(make({...hashed,provenance:{
      ...hashed.provenance,observedContentHash:"forged-revision"}}),
      identity.businessId,clause).operands).toHaveLength(0);
  });
  it("discards a repeated canonical handle when its readings conflict within one turn",()=>{
    const clauses=["Sophie works 45 additional minutes","Sophie works 20 additional minutes"];
    const sameResult=result(wageInput,workers);
    const changedResult=result(wageInput,[{...workers[0],
      defaultHourlyWageCents:2100,wageAmountCents:2100}]);
    const asEvidence=(source:unknown,clause:string)=>({
      clause,capabilityId:"p3.labor.employee_wages.v1",
      status:"partial" as const,result:source,reason:null,
    });
    const stable=projectP1Evidence([
      asEvidence(sameResult,clauses[0]),
      asEvidence(sameResult,clauses[1]),
    ],identity.businessId,clauses.join(" and "));
    expect(stable.operands).toHaveLength(1);
    expect(stable.choices).toHaveLength(2);
    const inconsistent=projectP1Evidence([
      asEvidence(sameResult,clauses[0]),
      asEvidence(changedResult,clauses[1]),
    ],identity.businessId,clauses.join(" and "));
    expect(inconsistent.operands).toHaveLength(0);
    expect(inconsistent.choices).toHaveLength(0);
    expect(inconsistent.missing).toContain(
      "conflicting_source_snapshot:labor.employee_wages");
    // Equal values are not a stable snapshot when completeness or staleness changed.
    const differentQuality={...sameResult,
      quality:{...sameResult.quality,staleInputs:["wage_changed"]}};
    const changedQuality=projectP1Evidence([
      asEvidence(sameResult,clauses[0]),
      asEvidence(differentQuality,clauses[1]),
    ],identity.businessId,clauses.join(" and "));
    expect(changedQuality.operands).toHaveLength(0);
    expect(changedQuality.choices).toHaveLength(0);
    // A third read equal to the first must not rehabilitate the conflicted leaf.
    const threeReads=projectP1Evidence([
      asEvidence(sameResult,clauses[0]),
      asEvidence(changedResult,clauses[1]),
      asEvidence(sameResult,clauses[0]),
    ],identity.businessId,clauses.join(" and "));
    expect(threeReads.operands).toHaveLength(0);
  });
  it("keeps identical sales fields separate for independent dated clauses",async()=>{
    const dates=["2026-10-01","2026-10-08"];
    const clauses=dates.map(date=>"Show sales on "+date);
    const readInput=(date:string)=>({id:"sales.daily",version:1,
      purpose:"actual_daily_sales",period:{from:date,to:date}});
    p1Reads.mockImplementation(async(_tools:unknown,_identity:unknown,raw:unknown)=>{
      const selected=raw as ReturnType<typeof readInput>;
      const date=selected.period.from;
      const baseResult=result(selected,[{date,netSalesCents:date===dates[0]?1000:2000,
        ordersCount:1,drinksCount:1,ingredientsCents:300,wagesCents:200,
        staffTaxCents:0,cardFeesCents:50,voidsCents:0}]);
      return {...baseResult,provenance:{...baseResult.provenance,
        canonicalReaderId:readers["sales.daily"]}};
    });
    let step=0;
    const provider=vi.fn(async(_url:string,init:RequestInit)=>{
      const request=JSON.parse(String(init.body)) as {input?:Array<{content:string}>};
      step++;
      if(step===1)return response({complete:true,clauses});
      if(step===2)return response({complete:true,choices:clauses.map((clause,i)=>({
        clause,capabilityId:"p3.sales.daily.v1",
        inputJson:JSON.stringify(readInput(dates[i])),reason:null,
      }))});
      const payload=JSON.parse(request.input?.[0]?.content??"{}") as {
        authorizedOperandChoices:Array<{handle:string;field:string;matchedClause:string}>;
      };
      const sales=payload.authorizedOperandChoices.filter(x=>x.field==="netSalesCents");
      expect(sales).toHaveLength(2);
      expect(new Set(sales.map(x=>x.handle)).size).toBe(2);
      for(let i=0;i<dates.length;i++)expect(sales[i]).toMatchObject({
        matchedClause:clauses[i],handle:expect.stringContaining(dates[i]),
      });
      return response({complete:true,plans:sales.map(choice=>({
        coveredClauses:[choice.matchedClause],reason:null,
        planJson:JSON.stringify({capabilityId:EXPRESSION_ID,version:1,
          purpose:"preauthorized_operands",description:"Recorded period sales",
          nodes:[{op:"source",handle:choice.handle}]}),
      }))});
    });
    const output=await run(provider,clauses.join(" and "));
    expect(output.reply.status).toBe("partial");
    expect(output.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"metric",valueCents:1000,
        label:expect.stringContaining("2026-10-01 / 2026-10-01")}),
      expect.objectContaining({type:"metric",valueCents:2000,
        label:expect.stringContaining("2026-10-08 / 2026-10-08")}),
    ]));
    expect(p1Reads).toHaveBeenCalledTimes(2);
  });
  it("never borrows a different worker's wage across independent named clauses",async()=>{
    const clauses=["Sophie works 45 extra minutes","Ahmed works 30 extra minutes"];
    const request=clauses.join(" and ");
    const wages=[...workers,{...workers[0],id:"ahmed",name:"Ahmed",
      defaultHourlyWageCents:2200,wageAmountCents:2200}];
    p1Reads.mockImplementation(async()=>result(wageInput,wages));
    const scenarioFor=(handle:string)=>({
      capabilityId:EXPRESSION_ID,version:1,purpose:"preauthorized_operands",
      description:"A source-backed named worker wage",
      nodes:[{op:"source",handle}],
    });
    const runCase=async(swapWorkers:boolean)=>{
      let step=0;
      const requests:Array<Record<string,unknown>>=[];
      const provider=vi.fn(async(_url:string,init:RequestInit)=>{
        const body=JSON.parse(String(init.body)) as Record<string,unknown>;
        requests.push(body);
        const phase=step++;
        if(phase===0)return response({complete:true,clauses});
        if(phase===1)return response({complete:true,choices:clauses.map(clause=>({
          clause,capabilityId:"p3.labor.employee_wages.v1",
          inputJson:JSON.stringify(wageInput),reason:null,
        }))});
        return response({complete:true,plans:clauses.map((clause,i)=>{
          const worker=swapWorkers?(i===0?"ahmed":"sophie"):
            (i===0?"sophie":"ahmed");
          return {coveredClauses:[clause],reason:null,
            planJson:JSON.stringify(scenarioFor(
              "labor.employee_wages:"+worker+":defaultHourlyWageCents"))};
        })});
      });
      const output=await run(provider,request);
      const planning=JSON.parse(((requests[2].input as Array<{content:string}>)[0]).content) as
        {authorizedOperandChoices:Array<{entityName:string;matchedClause:string}>};
      expect(planning.authorizedOperandChoices.filter(c=>c.entityName==="Sophie")
        .every(c=>c.matchedClause===clauses[0])).toBe(true);
      expect(planning.authorizedOperandChoices.filter(c=>c.entityName==="Ahmed")
        .every(c=>c.matchedClause===clauses[1])).toBe(true);
      return output;
    };
    const valid=await runCase(false);
    expect(valid.reply.status).toBe("partial");
    expect(valid.reply.evidence).toHaveLength(2);
    const swapped=await runCase(true);
    expect(swapped.reply.status).toBe("unavailable");
    expect(swapped.reply.blocks.some(v=>v.type==="metric")).toBe(false);
  });
  it("resolves a single owner-history product for a contextual follow-up",async()=>{
    const question="Sell 30 more drinks and Sophie works 45 more minutes";
    const phrases=["Sell 30 more drinks","Sophie works 45 more minutes"];
    const previous=[{role:"owner" as const,text:"Earlier, we discussed the latte"}];
    const futurePlan={...compositionPlan,nodes:compositionPlan.nodes.map(node=>
      node.op==="hypothetical"&&node.quotedNumber==="25"?
        {...node,quotedNumber:"30",value:30}:node)};
    let step=0;
    const mock=vi.fn(async()=>response([
      {complete:true,clauses:phrases},
      {complete:true,choices:[
        {clause:phrases[0],capabilityId:"p3.menu.catalog.v1",
          inputJson:JSON.stringify(menuInput),reason:null},
        {clause:phrases[1],capabilityId:"p3.labor.employee_wages.v1",
          inputJson:JSON.stringify(wageInput),reason:null},
      ]},
      {complete:true,plans:[{coveredClauses:phrases,
        planJson:JSON.stringify(futurePlan),reason:null}]},
    ][step++]));
    const result=await run(mock,question,"en",previous);
    expect(result.reply.status).toBe("partial");
    expect(result.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"metric",valueCents:10650}),
    ]));
    expect(p1Reads).toHaveBeenCalledWith(expect.anything(),expect.anything(),
      expect.objectContaining({id:"menu.product_economics",productId:"latte"}));
  });
  it("preserves configured access fallback for 403 and recognized 400/404 errors",async()=>{
    vi.stubEnv("SUPERVISOR_OPENAI_FALLBACK_MODEL","gpt-4.1-mini");
    for(const denied of [
      {status:403,code:"project_not_allowed"},
      {status:400,code:"model_not_found"},
      {status:404,code:"model_not_available"},
    ]){
    const seen:Array<Record<string,unknown>>=[];
    const goal={domain:"monthly_bills",period:"month_to_date",from:null,to:null,
      comparison_period:null,comparison_from:null,comparison_to:null};
    const providerReply=(output:unknown[])=>new Response(JSON.stringify({
      status:"completed",model:"gpt-4.1-mini",
      usage:{input_tokens:25,output_tokens:10},output,
    }),{status:200});
    const toolCall=(name:string,args:object,id:string)=>({
      type:"function_call",name,arguments:JSON.stringify(args),call_id:id,
    });
    const body=(value:unknown)=>[{type:"message",content:[{
      type:"output_text",text:JSON.stringify(value),
    }]}];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      const request=JSON.parse(String(init.body)) as Record<string,unknown>;
      seen.push(request);
      if(seen.length===1)return new Response(JSON.stringify({error:{
        type:"invalid_request_error",code:denied.code,
      }}),{status:denied.status});
      if((request.text as {format?:{name?:string}})?.format?.name==="supervisor_scope_audit")
        return providerReply(body({complete:true,ambiguous:false,goals:[goal]}));
      if(request.tool_choice==="required")return providerReply([
        toolCall("declare_request_scope",{goals:[goal]},"audit-scope"),
        toolCall("get_financials",{
          metric:"monthly_bills",period:"month_to_date",from:null,to:null,
        },"bills-call"),
      ]);
      return providerReply(body({headline:"Here is the recorded picture",summary:"Based on the available café records",
        fact_ids:["t1:bills"],task_ids:[],insight_ids:[],evidence_refs:[]}));
    });
    const billReader=vi.fn(async()=>({
      available:true,value:{totalCents:730000},quality:{level:"high",
        missingInputs:[],estimatedInputs:[],staleInputs:[]},
    }));
    const result=await runSupervisorTurn({
      text:"How much are my monthly bills?",locale:"en",asOf:identity.asOf,
      cafeName:"Fixture Cafe",timezone:identity.timezone,history:[],
      tools:{getMonthlyBills:billReader} as unknown as BusinessScopedCafeTools,
      readRules:async()=>[],
    },transport);
    expect(billReader).toHaveBeenCalledTimes(1);
    expect(result.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"metric",valueCents:730000}),
    ]));
    expect(seen.map(req=>req.model)).toEqual([
      "gpt-6-luna","gpt-4.1-mini","gpt-4.1-mini","gpt-4.1-mini",
    ]);
    expect(result.usage.modelCallCount).toBe(4);
    expect(result.usage.toolCallCount).toBe(1);
    expect(p1Reads).not.toHaveBeenCalled();
    }
  });
  it("COMPOSE-02/08: renders independently audited Spanish and Arabic scenario results",async()=>{
    for(const language of [
      {locale:"es" as const,question:"Vender 25 lattes y Sophie trabaja 45 minutos",
        clauses:["Vender 25 lattes","Sophie trabaja 45 minutos"]},
      {locale:"ar" as const,question:"بيع 25 latte و Sophie تعمل 45 دقيقة",
        clauses:["بيع 25 latte","Sophie تعمل 45 دقيقة"]},
    ]){
      p1Reads.mockClear();
      let step=0;
      const provider=vi.fn(async()=>response([
        {complete:true,clauses:language.clauses},
        {complete:true,choices:language.clauses.map((clause,i)=>({
          clause,capabilityId:i===0?"p3.menu.catalog.v1":
            "p3.labor.employee_wages.v1",
          inputJson:JSON.stringify(i===0?menuInput:wageInput),reason:null,
        }))},
        {complete:true,plans:[{coveredClauses:language.clauses,
          planJson:JSON.stringify(compositionPlan),reason:null}]},
      ][step++]));
      const outcome=await run(provider,language.question,language.locale);
      expect(outcome.reply.blocks).toEqual(expect.arrayContaining([
        expect.objectContaining({type:"metric",valueCents:8650}),
        expect.objectContaining({type:"warning",code:"P3_CONDITIONAL"}),
      ]));
      const text=JSON.stringify(outcome.reply.blocks);
      expect(language.locale==="es"?text.includes("condicional"):
        text.includes("مشروط")).toBe(true);
      expect(text).not.toMatch(/unversioned_source|unverified_source|unverified_input/);
      expect(text).not.toMatch(/unverified:|sourceRevision|labor\.employee_wages:/);
    }
  });


  it("refuses a reader period that differs from the exact owner date window",()=>{
    const chosen=(from:string,to:string,clause:string)=>[{
      clause,result:{query:{period:{from,to}}},
    }];
    const requested="Compare costs from 2026-10-01 to 2026-10-07";
    expect(verifiedReaderPeriods(chosen("2026-10-08","2026-10-14",requested),
      requested,identity.asOf)).toBe(false);
    expect(verifiedReaderPeriods(chosen("2026-10-01","2026-10-07",requested),
      requested,identity.asOf)).toBe(true);
    expect(verifiedReaderPeriods(chosen("2026-10-01","2026-10-07","labor on those dates"),
      requested+" and labor on those dates",identity.asOf)).toBe(true);
    expect(verifiedReaderPeriods(chosen("2026-10-10","2026-10-11","Costs last week"),
      "Costs last week",identity.asOf)).toBe(false);
    expect(verifiedReaderPeriods(chosen("2026-10-14","2026-10-14","Sales yesterday"),
      "Sales yesterday","2026-10-15")).toBe(true);
  });
  /**
   * Blind extension acceptance: new wording, item identities, units, dates and
   * combinations that were not part of the original latte/milk/wage fixtures.
   * All responses go through runSupervisorTurn, the real feature-flagged entry.
   * No question-specific handlers or injected arithmetic implementations.
   */
  const period={from:"2026-10-10",to:"2026-10-11"};
  const p1Envelope=(raw:{id:SupportedId;version:number;purpose:string;
    period?:{from:string;to:string}},value:unknown)=>{
    const output=result(raw,value);
    return {...output,query:raw,provenance:{...output.provenance,
      canonicalReaderId:readers[raw.id],selectorContractId:raw.id+".selector"}};
  };
  it.each([
    {name:"cinnamon roll",id:"roll-108",prior:23,added:37},
    {name:"pistachio muffin",id:"muffin-900",prior:46,added:19},
  ])("general pipeline composes unseen sold-item count for $name",async(fixture)=>{
    const question="Increase the recorded count for "+fixture.name+
      "s from 2026-10-10 to 2026-10-11 by "+fixture.added+" items";
    const read={id:"sales.item_units" as SupportedId,version:1,purpose:"covered_item_sales",period};
    p1Reads.mockImplementation(async(_tools:unknown,_identity:unknown,raw:unknown)=>{
      const input=raw as typeof read;
      if(input.id!=="sales.item_units")throw Error("unexpected source");
      return p1Envelope(input,[{id:fixture.id,name:fixture.name,category:"food",
        units:fixture.prior}]);
    });
    const expression={capabilityId:EXPRESSION_ID,version:1,
      purpose:"preauthorized_operands",
      description:"Combine covered recorded units with the quoted what-if count",
      nodes:[
        {op:"source",handle:"sales.item_units:"+fixture.id+":units:"+period.from+":"+period.to},
        {op:"hypothetical",quotedNumber:String(fixture.added),
          label:"owner-quoted additional units",value:fixture.added,unit:"item"},
        {op:"add"},
      ],
    };
    let step=0;
    const messages:Array<Record<string,unknown>>=[];
    const transport=vi.fn(async(_url:string,init:RequestInit)=>{
      messages.push(JSON.parse(String(init.body)) as Record<string,unknown>);
      return response([
        {complete:true,clauses:[question]},
        {complete:true,choices:[{clause:question,
          capabilityId:"p3.sales.item_units.v1",
          inputJson:JSON.stringify(read),reason:null}]},
        {complete:true,plans:[{coveredClauses:[question],
          planJson:JSON.stringify(expression),reason:null}]},
      ][step++]);
    });
    const output=await run(transport,question);
    expect(output.reply.status).toBe("partial");
    expect(output.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"text",
        text:expect.stringContaining(String(fixture.prior+fixture.added)+" items")}),
      expect.objectContaining({type:"warning",code:"P3_SOURCE_LIMITATIONS"}),
    ]));
    expect(output.usage).toMatchObject({modelCallCount:3,toolCallCount:2});
    expect(p1Reads).toHaveBeenCalledTimes(1);
    const planning=JSON.parse(
      (messages[2].input as Array<{content:string}>)[0].content) as {
        authorizedOperandChoices:Array<{entityName:string;field:string}>;
      };
    expect(planning.authorizedOperandChoices).toEqual(expect.arrayContaining([
      expect.objectContaining({entityName:fixture.name,field:"units"}),
    ]));
    // Private source amounts remain in the deterministic server context.
    expect(JSON.stringify(messages[2])).not.toContain('"value":'+fixture.prior);
  });
  it("composes unseen sales, payment fees and loaded labor across a shared date range",async()=>{
    const salesClause="Take net sales less card fees from 2026-10-10 to 2026-10-11";
    const laborClause="subtract loaded staff cost for those dates";
    const question=salesClause+" and "+laborClause;
    const salesInput={id:"sales.daily" as SupportedId,version:1,
      purpose:"actual_daily_sales",period};
    const laborInput={id:"labor.daily_costs" as SupportedId,version:1,
      purpose:"recorded_labor_cost_review",period};
    const sales=[
      {date:"2026-10-10",netSalesCents:100000,ordersCount:50,drinksCount:71,
        ingredientsCents:20000,wagesCents:16000,staffTaxCents:4000,
        cardFeesCents:3000,voidsCents:0},
      {date:"2026-10-11",netSalesCents:130000,ordersCount:65,drinksCount:81,
        ingredientsCents:27000,wagesCents:19000,staffTaxCents:6000,
        cardFeesCents:3500,voidsCents:0},
    ];
    const labor=[
      {date:"2026-10-10",wagesCents:18000,staffTaxCents:4000,
        loadedStaffCostCents:22000},
      {date:"2026-10-11",wagesCents:19000,staffTaxCents:4000,
        loadedStaffCostCents:23000},
    ];
    p1Reads.mockImplementation(async(_tools:unknown,_identity:unknown,raw:unknown)=>{
      const request=raw as typeof salesInput;
      if(request.id==="sales.daily")return p1Envelope(request,sales);
      if(request.id==="labor.daily_costs")return p1Envelope(request,labor);
      throw Error("Only authorized daily domains should be read");
    });
    const expression={capabilityId:EXPRESSION_ID,version:1,
      purpose:"preauthorized_operands",
      description:"Sales less fees and loaded wages for the exact same period",
      nodes:[
        {op:"source",handle:"sales.daily:aggregate:netSalesCents:"+period.from+":"+period.to},
        {op:"source",handle:"sales.daily:aggregate:cardFeesCents:"+period.from+":"+period.to},
        {op:"subtract"},
        {op:"source",handle:"labor.daily_costs:aggregate:loadedStaffCostCents:"+period.from+":"+period.to},
        {op:"subtract"},
      ],
    };
    let step=0;
    const transport=vi.fn(async()=>response([
      {complete:true,clauses:[salesClause,laborClause]},
      {complete:true,choices:[
        {clause:salesClause,capabilityId:"p3.sales.daily.v1",
          inputJson:JSON.stringify(salesInput),reason:null},
        {clause:laborClause,capabilityId:"p3.labor.daily_costs.v1",
          inputJson:JSON.stringify(laborInput),reason:null},
      ]},
      {complete:true,plans:[{coveredClauses:[salesClause,laborClause],
        planJson:JSON.stringify(expression),reason:null}]},
    ][step++]));
    const output=await run(transport,question);
    expect(output.reply.status).toBe("partial");
    // 230000 net sales - 6500 in fees - 45000 in loaded staff = 178500.
    // This is a conditional subtotal, NEVER verified net profit.
    expect(output.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"metric",valueCents:178500}),
      expect.objectContaining({type:"warning",code:"P3_BASELINE"}),
    ]));
    expect(output.usage).toMatchObject({modelCallCount:3,toolCallCount:3});
    expect(p1Reads).toHaveBeenCalledTimes(2);
  });
  it("explains genuinely missing numeric inputs without inventing business totals",async()=>{
    const question="Increase recorded cinnamon rolls from 2026-10-10 to 2026-10-11 by 37 items";
    const read={id:"sales.item_units" as SupportedId,version:1,
      purpose:"covered_item_sales",period};
    p1Reads.mockImplementation(async()=>p1Envelope(read,[]));
    let step=0;
    const provider=vi.fn(async()=>response([
      {complete:true,clauses:[question]},
      {complete:true,choices:[{clause:question,
        capabilityId:"p3.sales.item_units.v1",inputJson:JSON.stringify(read),
        reason:null}]},
      {complete:true,plans:[{coveredClauses:[question],
        planJson:null,reason:"missing_input"}]},
    ][step++]));
    const output=await run(provider,question);
    expect(output.reply.status).toBe("unavailable");
    expect(output.reply.evidence).toEqual([]);
    expect(output.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"warning",code:"P3_MISSING_INPUT"}),
    ]));
    expect(output.reply.blocks.some(block=>block.type==="metric"||
      block.type==="count")).toBe(false);
    expect(output.usage).toMatchObject({modelCallCount:3,toolCallCount:1});
  });
  it("declines a wholly unsupported action without invoking a mutation or fake calculation",async()=>{
    const question="Publish tomorrow's staff schedule";
    let step=0;
    const provider=vi.fn(async()=>response([
      {complete:true,clauses:[question]},
      {complete:true,choices:[{clause:question,capabilityId:null,
        inputJson:null,reason:"unsupported"}]},
      {complete:true,plans:[{coveredClauses:[question],
        planJson:null,reason:"unsupported_action"}]},
    ][step++]));
    const output=await run(provider,question);
    expect(output.reply.status).toBe("unavailable");
    expect(output.reply.evidence).toEqual([]);
    expect(output.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"warning",code:"P3_UNSUPPORTED_ACTION"}),
    ]));
    expect(output.usage).toMatchObject({modelCallCount:3,toolCallCount:0});
    expect(p1Reads).not.toHaveBeenCalled();
  });

});
