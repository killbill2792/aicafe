import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeInitiativeTool, initiativeToolDefinitions } from "./initiatives";
import type { AgentToolContext } from "./index";

const state=vi.hoisted(()=>({owner:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",proposals:0,checkins:0}));
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
  listOwnerInitiatives:async()=>[{id:"33333333-3333-4333-8333-333333333333",status:"active",
    title:"Keep coffee revenue",kind:"goal",starts_on:"2026-10-22",ends_on:"2026-10-29"}],
  readOwnerInitiative:async()=>({
    initiative:{id:"33333333-3333-4333-8333-333333333333",status:"active",title:"Keep coffee revenue",revision:2,
      starts_on:"2026-10-22",ends_on:"2026-10-29"},
    metrics:[{id:"44444444-4444-4444-8444-444444444444",role:"primary",source:"checkin",metric_key:null,
      params:{},comparator:"gte",target_kind:"absolute",target:1,
      checkin_question:"Was everything ready?",checkin_audience:"owner",data_gap:"Needs owner answer"}],
    observations:[],evaluation:null,
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
beforeEach(()=>{state.proposals=0;state.checkins=0;});
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
    const list=await executeInitiativeTool("get_initiatives",{status:null},context);
    expect(list.items).toEqual([expect.objectContaining({id:initiativeId,status:"active"})]);
    const detail=await executeInitiativeTool("get_initiative_status",{id:initiativeId,metricId:null,date:null},context);
    expect(detail.metrics).toEqual([expect.objectContaining({id:metricId,question:"Was everything ready?"})]);
    expect(detail.missing).toEqual(["evaluationPending"]);
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
