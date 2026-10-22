import { describe,expect,it } from "vitest";
import { initiativeToolDefinitions, initiativeToolSchemas } from "./initiatives";
import { metricKeySchema } from "@/lib/calc/metrics/catalog";
import { proposeInitiativeSchema } from "@/lib/initiatives/contracts";

const uuid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const proposal={
  threadId:uuid,kind:"goal" as const,title:"Sell more coffee",
  changeDescription:"",changeSpec:{},adapterId:null,
  startsOn:"2026-10-22",endsOn:"2026-10-29",baselineFrom:"2026-10-15",baselineTo:"2026-10-21",
  checkinCadence:"weekly" as const,
  metrics:[{role:"primary" as const,source:"computed" as const,metricKey:"net_sales" as const,
    params:{},comparator:"gte" as const,targetKind:"relative_pct" as const,target:5,
    checkinQuestion:null,checkinAudience:null,dataGap:null}],
};
describe("initiative tools adhere to strict agent contracts",()=>{
  it("exports a strict schema without a JSON $schema key",()=>{
    expect(initiativeToolDefinitions).toHaveLength(4);
    for(const tool of initiativeToolDefinitions){
      expect(tool.strict).toBe(true);
      expect(Object.hasOwn(tool.parameters,"$schema")).toBe(false);
      expect(tool.parameters).toHaveProperty("additionalProperties",false);
    }
    expect(initiativeToolSchemas.propose_initiative.safeParse({...proposal,threadId:undefined}).success).toBe(false);
  });
  it("accepts valid goal data and rejects invented metric keys",()=>{
    expect(proposeInitiativeSchema.safeParse(proposal).success).toBe(true);
    expect(metricKeySchema.safeParse("made_up_margin").success).toBe(false);
    expect(proposeInitiativeSchema.safeParse({...proposal,metrics:[{
      ...proposal.metrics[0],metricKey:"invented"
    }]}).success).toBe(false);
  });
  it("requires source checkin for noncomputed measurements",()=>{
    const question={...proposal.metrics[0],source:"checkin",metricKey:null,
      checkinQuestion:"Did deliveries arrive?",checkinAudience:"owner",dataGap:"No POS inventory measurement"};
    expect(proposeInitiativeSchema.safeParse({...proposal,metrics:[question]}).success).toBe(true);
    expect(proposeInitiativeSchema.safeParse({...proposal,metrics:[{...question,metricKey:"net_sales"}]}).success).toBe(false);
  });
});
