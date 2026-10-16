import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("server-only",()=>({}));
import type { BusinessScopedCafeTools } from "@/lib/ai/tools";
import { runSupervisorTurn } from "./runSupervisorTurn.server";
import { EXPRESSION_ID } from "@/lib/ai/supervisor/p3/expression";
import type { SupportedId } from "@/lib/metrics/p1Catalog";

const identity={businessId:"cafe-test",asOf:"2026-10-15",
  timezone:"America/Los_Angeles",currency:"USD"};
const menuInput={id:"menu.catalog",version:1,purpose:"menu_catalog_review"};
const wageInput={id:"labor.employee_wages",version:1,
  purpose:"authorized_owner_wage_review"};
const quality={level:"low",missingInputs:["unversioned_source"],
  estimatedInputs:[],staleInputs:[]};
const menu=[{id:"latte",name:"latte",category:"drink",
  active:true,priceCents:525,priceStatus:"recorded"}];
const workers=[{id:"sophie",name:"Sophie",role:"barista",active:true,
  defaultHourlyWageCents:1800,wagePeriod:"hour",wageAmountCents:1800,
  wageKnown:true,wageProvenance:"recorded_positive"}];
const result=(input:{id:string;version:number;purpose:string},value:unknown)=>({
  id:input.id,version:1,query:input,unit:"typed_record",valueKind:"record",
  status:"partial",completeness:"partial",actuality:"actual",
  value,quality,provenance:{
    canonicalReaderId:input.id==="menu.catalog"?"readP1MenuCatalog":
      "readP1EmployeeWages",readerContractVersion:1,
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
    {op:"source",handle:"menu.catalog:latte:priceCents"},
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
const run=(transport:ReturnType<typeof makeTransport>["calls"])=>
  runSupervisorTurn({
    text:goal,locale:"en",asOf:identity.asOf,timezone:identity.timezone,
    cafeName:"Fixture Cafe",history:[],
    tools:{} as BusinessScopedCafeTools,readRules:async()=>[],
  },transport);

describe("COMPOSE end-to-end compatibility-flagged Supervisor",()=>{
  beforeEach(()=>{
    vi.stubEnv("OPENAI_API_KEY","fixture-not-live");
    vi.stubEnv("SUPERVISOR_OPENAI_MODEL","gpt-6-luna");
    vi.stubEnv("SUPERVISOR_P3_COMPOSITION_ENABLED","true");
    p1Auth.mockReset().mockResolvedValue({identity,tools:{} as BusinessScopedCafeTools});
    p1Reads.mockReset().mockImplementation(async(_tools:unknown,_identity:unknown,raw:unknown)=>{
      const id=(raw as {id:SupportedId}).id;
      if(id==="menu.catalog")return result(menuInput,menu);
      if(id==="labor.employee_wages")return result(wageInput,workers);
      throw Error("Unsupported fixture source");
    });
  });
  afterEach(()=>vi.unstubAllEnvs());
  it("COMPOSE-01/02/03/04: uses previously unseen model expression, both P1 source domains and exact cents",async()=>{
    const transport=makeTransport();
    const outcome=await run(transport.calls);
    expect(outcome.reply.status).toBe("partial");
    expect(outcome.reply.blocks).toEqual(expect.arrayContaining([
      expect.objectContaining({type:"metric",valueCents:11775}),
      expect.objectContaining({type:"warning",code:"P3_CONDITIONAL"}),
    ]));
    expect(outcome.reply.blocks).not.toContainEqual(expect.objectContaining({
      type:"task_card",
    }));
    expect(p1Reads).toHaveBeenCalledTimes(2);
    expect(outcome.usage).toMatchObject({modelCallCount:3,toolCallCount:2});
    expect(transport.requests.every(req=>req.store===false)).toBe(true);
    expect(transport.requests.every(req=>!JSON.stringify(req).includes("525")))
      .toBe(true);
  });
  it("COMPOSE-05/06/07: forged source handle never produces a numerical fact",async()=>{
    const transport=makeTransport({tamper:true});
    // An invalid P3 plan must not be passed through as trusted numbers.
    // Legacy may be asked to perform a normal read, but cannot use the forged handle.
    const output=await run(transport.calls).catch(e=>e);
    expect(output?.reply?.blocks?.some((v:{valueCents?:number})=>v.valueCents===11775))
      .not.toBe(true);
  });
  it("COMPOSE-08: rejects provider failure without executing domain effects",async()=>{
    const transport=makeTransport({providerFailure:true});
    const output=await run(transport.calls).catch(e=>e);
    expect(output?.reply?.blocks?.some((v:{type:string})=>v.type==="metric"))
      .not.toBe(true);
    expect(p1Reads).not.toHaveBeenCalled();
  });
});
