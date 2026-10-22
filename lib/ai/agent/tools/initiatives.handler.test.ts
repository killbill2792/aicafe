import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeInitiativeTool, initiativeToolDefinitions } from "./initiatives";
import type { AgentToolContext } from "./index";

const state=vi.hoisted(()=>({owner:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",proposals:0,checkins:0,metricCount:1,heavy:false,withTypedMetrics:false,listCount:1}));
const businessId="11111111-1111-4111-8111-111111111111";
const threadId="22222222-2222-4222-8222-222222222222";
const initiativeId="33333333-3333-4333-8333-333333333333";
const metricId="44444444-4444-4444-8444-444444444444";
vi.mock("@/lib/ai/conversations/auth.server",()=>({
  authenticatedConversationContext: async()=>({scope:{businessId:"11111111-1111-4111-8111-111111111111",ownerUserId:state.owner}}),
}));
vi.mock("@/lib/data/initiatives.server",()=>({
  createOwnerInitiative:async()=>{state.proposals++;return {id:"33333333-3333-4333-8333-333333333333",revision:1,
    kind:"goal",title:"Keep coffee revenue",change_description:""};},
  listOwnerInitiatives:async(_scope:unknown,_status:unknown,afterId?:string)=>
    Array.from({length:Math.max(0,state.listCount-(afterId?5:0))},(_,i)=>({
      id:i===0&&!afterId?initiativeId:
        String((afterId?6:1)+i).padStart(8,"0")+"-3333-4333-8333-333333333333",
      status:"active",title:state.heavy?"🌱".repeat(160):"Keep coffee revenue",
      kind:"goal",starts_on:"2026-10-22",ends_on:"2026-10-29",
    })).slice(0,6),
  readOwnerInitiative:async()=>({
    initiative:{id:"33333333-3333-4333-8333-333333333333",status:"active",title:"Keep coffee revenue",revision:2,
      starts_on:"2026-10-22",ends_on:"2026-10-29"},
    metrics:Array.from({length:state.metricCount},(_,i)=>({
      id:i===0?"44444444-4444-4444-8444-444444444444":
        String(i).padStart(8,"0")+"-4444-4444-8444-444444444444",
      role:i===0?"primary":"guardrail",
      source:state.withTypedMetrics?"computed":"checkin",
      metric_key:state.withTypedMetrics?(i<2?"item_units":i===2?"ingredient_unit_cost":"sales_per_labor_hour"):null,
      params:state.withTypedMetrics?i<2?{itemId:i===0?
        "66666666-6666-4666-8666-666666666666":
        "77777777-7777-4777-8777-777777777777"}:
        i===2?{ingredientId:"88888888-8888-4888-8888-888888888888"}:
        {fromHour:9,toHour:12}:{},
      comparator:"gte",target_kind:"absolute",target:1,
      checkin_question:state.withTypedMetrics?null:state.heavy?"Q".repeat(299):"Was everything ready?",
      checkin_audience:state.withTypedMetrics?null:"owner",
      data_gap:state.withTypedMetrics?null:state.heavy?"D".repeat(299):"Needs owner answer",
    })),
    observations:state.heavy?Array.from({length:20},(_,i)=>({metric_id:metricId,
      business_date:"2026-10-22",value:i,coverage:1,source:"owner_checkin",revision:i+1})):[],
    evaluation:state.heavy?{status:"on_track",recommendation:"keep",as_of:"2026-10-22",
      results:{[metricId]:{baseline:1,current:1,target:1,coverage:1,met:true,
        huge:"x".repeat(4000)}}}:null,
  }),
  saveOwnerCheckin:async(scope:{ownerUserId:string},id:string,date:string,value:number|null)=>{
    if(scope.ownerUserId!==state.owner||id!=="44444444-4444-4444-8444-444444444444"||
        date!=="2026-10-22"||(value!==1&&value!==null))throw Error("wrong check-in scope");
    state.checkins++;return {created:true,corrected:false,revision:1};
  },
}));
const context:AgentToolContext={
  asOf:"2026-10-22",locale:"en",threadId,ownerMessageId:"55555555-5555-4555-8555-555555555555",
  tools:{
    getProfitability:async()=>({available:false,value:null,
      quality:{level:"low",missingInputs:["unavailable"],estimatedInputs:[],staleInputs:[]}}),
    getSalesTrend:async()=>({available:false,value:null,
      quality:{level:"low",missingInputs:["unavailable"],estimatedInputs:[],staleInputs:[]}}),
    getMenuCatalog:async()=>({available:false,value:null,
      quality:{level:"low",missingInputs:["unavailable"],estimatedInputs:[],staleInputs:[]}}),
  },
};
const proposal={
  kind:"goal",title:"Keep coffee revenue",changeDescription:"",changeSpecJson:"{}",adapterId:null,
  startsOn:"2026-10-22",endsOn:"2026-10-29",baselineFrom:"2026-10-15",baselineTo:"2026-10-21",
  checkinCadence:"end_only",
  metrics:[{role:"primary",source:"checkin",metricKey:null,
    params:{itemId:null,ingredientId:null,fromHour:null,toHour:null},
    comparator:"gte",targetKind:"absolute",target:1,checkinQuestion:"Was everything ready?",
    checkinAudience:"owner",dataGap:"Needs owner answer"}],
};
beforeEach(()=>{state.proposals=0;state.checkins=0;state.metricCount=1;state.heavy=false;state.withTypedMetrics=false;state.listCount=1;});
describe("owner-scoped initiative agent handlers",()=>{
  it("proposes only with server-origin thread and returns actionable metric IDs",async()=>{
    const result=await executeInitiativeTool("propose_initiative",proposal,context);
    expect(state.proposals).toBe(1);
    expect(result.status).toBe("proposed");
    expect(result.display).toMatchObject({type:"approval_card",requiresOwnerApproval:true,revision:1});
    expect(result.metrics).toEqual([expect.objectContaining({id:metricId,source:"checkin"})]);
    await expect(executeInitiativeTool("propose_initiative",proposal,{...context,threadId:undefined}))
      .rejects.toThrow("thread context");
    expect(state.proposals).toBe(1);
  });
  it("lists owner-only IDs and reads metric questions and dates",async()=>{
    const list=await executeInitiativeTool("get_initiatives",{status:null,afterId:null},context);
    expect(list.items).toEqual([expect.objectContaining({id:initiativeId,status:"active"})]);
    const detail=await executeInitiativeTool("get_initiative_status",{id:initiativeId,metricId:null,date:null},context);
    expect(detail.metrics).toEqual([expect.objectContaining({id:metricId,source:"checkin"})]);
    expect((detail.metrics as Array<Record<string,unknown>>)[0]).not.toHaveProperty("question");
    const selected=await executeInitiativeTool("get_initiative_status",{
      id:initiativeId,metricId,date:"2026-10-22",
    },context);
    expect(selected.metricDetail).toMatchObject({id:metricId,question:"Was everything ready?"});
    expect(detail.missing).toEqual(["evaluationPending","checkinPending"]);
  });
  it("pages compact titles and keeps the entire serialized list within budget",async()=>{
    state.heavy=true;state.listCount=20;
    const first=await executeInitiativeTool("get_initiatives",{status:null,afterId:null},context);
    expect((first.items as unknown[])).toHaveLength(5);
    expect(first.hasMore).toBe(true);
    expect(typeof first.nextAfterId).toBe("string");
    expect(JSON.stringify(first).length).toBeLessThan(3300);
    const next=await executeInitiativeTool("get_initiatives",{
      status:null,afterId:first.nextAfterId,
    },context);
    expect((next.items as unknown[])).toHaveLength(5);
    expect(JSON.stringify(next).length).toBeLessThan(3300);
  });
  it("returns every proposed metric plus the thirteenth confirmation guardrail",async()=>{
    state.metricCount=13;
    const result=await executeInitiativeTool("get_initiative_status",{
      id:initiativeId,metricId:null,date:null,
    },context);
    expect((result.metrics as unknown[])).toHaveLength(13);
    expect((result.metrics as Array<{id:string}>)[12].id).toBe("00000012-4444-4444-8444-444444444444");
  });
  it("keeps all 13 IDs within the 1.5k-token response budget, even with maximum questions and rich evidence",async()=>{
    state.metricCount=13;state.heavy=true;
    const summary=await executeInitiativeTool("get_initiative_status",{
      id:initiativeId,metricId:null,date:null,
    },context);
    expect((summary.metrics as unknown[])).toHaveLength(13);
    expect(JSON.stringify(summary).length).toBeLessThan(4000);
    expect(JSON.stringify(summary)).not.toContain("Q".repeat(100));
    expect(JSON.stringify(summary)).not.toContain("x".repeat(100));
    const detail=await executeInitiativeTool("get_initiative_status",{
      id:initiativeId,metricId,date:"2026-10-22",
    },context);
    expect((detail.metricDetail as {question:string}).question).toHaveLength(299);
    expect((detail.observation as {revision:number}).revision).toBe(1);
    expect(JSON.stringify(detail).length).toBeLessThan(5200);
    expect(JSON.stringify(detail)).not.toContain("x".repeat(100));
  });
  it("distinguishes two item metrics and scopes ingredient / hour parameters in selected detail",async()=>{
    state.withTypedMetrics=true;state.metricCount=4;
    const read=async(id:string)=>executeInitiativeTool("get_initiative_status",{
      id:initiativeId,metricId:id,date:"2026-10-22",
    },context);
    const first=await read(metricId);
    const second=await read("00000001-4444-4444-8444-444444444444");
    const ingredient=await read("00000002-4444-4444-8444-444444444444");
    const hours=await read("00000003-4444-4444-8444-444444444444");
    expect(first.metricDetail).toMatchObject({metricKey:"item_units",
      params:{itemId:"66666666-6666-4666-8666-666666666666"}});
    expect(second.metricDetail).toMatchObject({metricKey:"item_units",
      params:{itemId:"77777777-7777-4777-8777-777777777777"}});
    expect(ingredient.metricDetail).toMatchObject({metricKey:"ingredient_unit_cost",
      params:{ingredientId:"88888888-8888-4888-8888-888888888888"}});
    expect(hours.metricDetail).toMatchObject({metricKey:"sales_per_labor_hour",
      params:{fromHour:9,toHour:12}});
    const directory=await executeInitiativeTool("get_initiative_status",{
      id:initiativeId,metricId:null,date:null,
    },context);
    expect((directory.metrics as Array<Record<string,unknown>>).every(m=>!("params" in m))).toBe(true);
  });
  it("records only referenced check-ins and rejects unknown arguments",async()=>{
    const result=await executeInitiativeTool("record_checkin",{
      metricId,date:"2026-10-22",expectedRevision:null,value:1,note:null,
    },context);
    expect(result.created).toBe(true);
    expect(state.checkins).toBe(1);
    await expect(executeInitiativeTool("record_checkin",{
      metricId,date:"2026-10-22",value:1,note:null,ownerUserId:"forged",
    },context)).rejects.toThrow();
    expect(state.checkins).toBe(1);
  });
  it("preserves missing evidence for a note-only check-in",async()=>{
    const note=await executeInitiativeTool("record_checkin",{
      metricId,date:"2026-10-22",expectedRevision:null,value:null,note:"The delivery was late",
    },context);
    expect(note.missing).toContain("checkinNumericValueMissing");
  });
  it("keeps the strict tool declaration set closed",()=>{
    expect(initiativeToolDefinitions.map(x=>x.name)).toEqual([
      "propose_initiative","get_initiatives","get_initiative_status","record_checkin"]);
    for(const def of initiativeToolDefinitions){
      expect(def.strict).toBe(true);
      expect(def.parameters.additionalProperties).toBe(false);
      expect(Object.hasOwn(def.parameters,"$schema")).toBe(false);
    }
  });
});
