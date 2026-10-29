import {describe,expect,it} from "vitest";
import {goalMetricsFromRequest,baselineDatesFor,scoreGoal,goalEffectSchema,type GoalEffect,type GoalObservation} from "./goalSpec";
import {goalTitle,goalReportText,goalMidRunText,goalPreview} from "./goalText";

const latte="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const metrics=goalMetricsFromRequest({metric:"avg_ticket",itemId:null,direction:"up",targetKind:"percent",target:5,days:7,
  guardrails:[{metric:"orders",itemId:null,direction:"not_below",percent:10}]},new Map());
const effect:GoalEffect=goalEffectSchema.parse({title:goalTitle(metrics[0],"en","USD"),metrics,days:7,
  proposedOn:"2026-10-01",baselineFrom:"2026-09-17",baselineTo:"2026-09-30",currency:"USD"});
/** Seven goal days; avg ticket and orders each day, with matching before-period weekdays. */
function samples(ticket:number,orders:number,beforeTicket=800,beforeOrders=100){
  return Array.from({length:7},(_,i)=>{
    const date="2026-10-0"+(i+2);
    const base=baselineDatesFor(date,effect.baselineFrom,effect.baselineTo);
    const observation:GoalObservation={
      values:{primary:{value:ticket,coverage:1},guardrail1:{value:orders,coverage:1}},
      baseline:{primary:base.map(d=>({date:d,value:beforeTicket,coverage:1})),
        guardrail1:base.map(d=>({date:d,value:beforeOrders,coverage:1}))}};
    return {businessDate:date,observation};
  });
}

describe("goal spec",()=>{
  it("turns the owner's request into a primary target and a guardrail",()=>{
    expect(metrics).toEqual([
      {id:"primary",role:"primary",metricKey:"avg_ticket",itemId:null,itemName:null,comparator:"gte",targetKind:"relative_pct",target:5},
      {id:"guardrail1",role:"guardrail",metricKey:"orders",itemId:null,itemName:null,comparator:"gte",targetKind:"relative_pct",target:-10},
    ]);
    const down=goalMetricsFromRequest({metric:"item_units",itemId:latte,direction:"down",targetKind:"percent",target:3,days:7,guardrails:[]},
      new Map([[latte,"Latte"]]));
    expect(down[0]).toMatchObject({comparator:"lte",target:-3,itemName:"Latte"});
  });
  it("matches each day to the same weekdays in the two weeks before",()=>{
    // 2026-10-02 is a Friday; the before-period Fridays are 25 and 18 September.
    expect(baselineDatesFor("2026-10-02","2026-09-17","2026-09-30")).toEqual(["2026-09-25","2026-09-18"]);
  });
  it("is met when average ticket rose 5% and orders held",()=>{
    const r=scoreGoal(effect,samples(840,100),true);
    expect(r).toMatchObject({status:"complete",recommendation:"keep"});
    expect(r.evaluation.status).toBe("met");
    expect(r.evaluation.results.primary).toMatchObject({baseline:800,current:840,target:840,met:true});
  });
  it("is missed when the target was not reached",()=>{
    const r=scoreGoal(effect,samples(810,100),true);
    expect(r.evaluation.status).toBe("missed");
    expect(r.recommendation).toBe("adjust");
  });
  it("flags a broken guardrail even when the main number went up",()=>{
    const r=scoreGoal(effect,samples(900,80),true);
    expect(r.evaluation.status).toBe("missed");
    expect(r.evaluation.results.guardrail1.met).toBe(false);
  });
  it("says not enough data when most days are unverified",()=>{
    const s=samples(840,100).map((x,i)=>i<3?x:{...x,observation:{...x.observation,
      values:{primary:{value:null,coverage:0},guardrail1:{value:null,coverage:0}}}});
    expect(scoreGoal(effect,s,true)).toMatchObject({status:"insufficient_evidence"});
  });
  it("counts days with no sample as missing, so one day never passes for a whole goal",()=>{
    const window={start:"2026-10-02",through:"2026-10-08"};
    expect(scoreGoal(effect,samples(840,100).slice(0,1),true,window)).toMatchObject({status:"insufficient_evidence",asOf:"2026-10-08"});
    expect(scoreGoal(effect,samples(840,100),true,window)).toMatchObject({status:"complete",recommendation:"keep"});
    // Samples outside the window are ignored.
    expect(scoreGoal(effect,samples(840,100),true,{start:"2026-10-02",through:"2026-10-03"}).evaluation.results.primary)
      .toMatchObject({current:840});
  });
  it("stays in progress before the last day",()=>{
    expect(scoreGoal(effect,samples(840,100).slice(0,3),false).status).toBe("in_progress");
  });
});

describe("goal text",()=>{
  it("titles, card rows and report read as plain sentences in the café currency",()=>{
    expect(effect.title).toBe("Average ticket up 5%");
    expect(goalPreview(effect,"en").map(r=>r.after)).toEqual([
      {kind:"text",text:"Average ticket up 5%"},{kind:"text",text:"Average ticket"},
      {kind:"count",n:7,unit:"days"},{kind:"text",text:"Orders a day must not drop more than 10%"}]);
    const report=goalReportText(effect,scoreGoal(effect,samples(840,100),true),"en");
    expect(report).toContain("Goal report for Average ticket up 5%: met.");
    expect(report).toContain("Average ticket: $8.40 vs $8.00 before (target $8.40), on target");
    expect(report).toContain("Orders a day (guardrail): 100 vs 100 before (target 90), on target");
    expect(report).toContain("Recommendation: keep doing what you changed.");
  });
  it("writes a halfway update that is labelled early",()=>{
    const text=goalMidRunText(effect,scoreGoal(effect,samples(840,100).slice(0,3),false),"es");
    expect(text).toMatch(/^Actualización a mitad de Average ticket up 5%/);
    expect(text).toContain("después del día 7");
  });
});
