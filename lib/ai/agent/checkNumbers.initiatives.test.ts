import {describe,expect,it} from "vitest";
import {checkNumbers,compactEvidence} from "./checkNumbers";
import type {AgentToolResult} from "./tools";

const initiativeId="33333333-3333-4333-8333-333333333333";
const metricId="44444444-4444-4444-8444-444444444444";
const fixture=(metricKey:"net_sales"|"orders"|"cogs_pct",unit:"cents"|"count"|"bps",
  current:number|null,coverage=1):AgentToolResult=>({
  source:"owner_initiatives",period:null,missing:coverage<0.8?["sourceGap"]:[],
  initiative:{id:initiativeId,status:"active"},
  metricDetail:{id:metricId,source:"computed",role:"primary",metricKey,unit,
    params:{},comparator:"gte",targetKind:"absolute",target:metricKey==="net_sales"?10000:
      metricKey==="cogs_pct"?1000:10},
  metricEvaluation:{baseline:metricKey==="net_sales"?9000:null,
    current,target:metricKey==="net_sales"?10000:metricKey==="cogs_pct"?1000:10,
    coverage,met:coverage===1},
  observation:{metricId,date:"2026-10-20",value:current,coverage,
    source:"computed",revision:2},
});

describe("catalog-scoped initiative numeric verification",()=>{
  it("recognizes unit-bearing money/current/target and persists those values",()=>{
    const read=fixture("net_sales","cents",12000);
    expect(checkNumbers("Sales $120 versus our $100 target","",[read],"en")).toEqual([]);
    expect(checkNumbers("Sales $1200","",[read],"en").map(x=>x.text)).toContain("$1200");
    const saved=compactEvidence([read]);
    expect(saved[0].values).toEqual(expect.arrayContaining([
      expect.objectContaining({value:12000,unit:"cents"}),
      expect.objectContaining({value:10000,unit:"cents"}),
    ]));
    expect(saved[0].values.every(v=>v.key.includes("metric:"+metricId))).toBe(true);
  });
  it("matches daily sales by date and catalog metric rather than identical money alone",()=>{
    const source=fixture("net_sales","cents",12000);
    expect(checkNumbers("Sales on 2026-10-20 were $120","",[source],"en")).toEqual([]);
    expect(checkNumbers("Sales on 2026-10-19 were $120","",[source],"en").length)
      .toBeGreaterThan(0);
    const unrelated:AgentToolResult={...source,metricDetail:{
      ...source.metricDetail as object,metricKey:"avg_ticket",
    }};
    expect(checkNumbers("Sales on 2026-10-20 were $120","",[unrelated],"en").length)
      .toBeGreaterThan(0);
    const prior=compactEvidence([source]);
    expect(checkNumbers("Sales on 2026-10-20 were $120","",[],"en",prior)).toEqual([]);
  });
  it("recognizes catalog counts and basis-point percentages, not unrelated numbers",()=>{
    const orders=fixture("orders","count",15);
    const percent=fixture("cogs_pct","bps",1250);
    expect(checkNumbers("15 orders and 12.5% COGS","",[orders,percent],"en")).toEqual([]);
    expect(checkNumbers("25 orders and 99% COGS","",[orders,percent],"en").length).toBe(2);
  });
  it("invalidates stale values after a correction instead of retaining a prior amount",()=>{
    const old=fixture("net_sales","cents",12000);
    const changed=fixture("net_sales","cents",9000);
    const previous=compactEvidence([old]);
    expect(checkNumbers("Sales $120","",[changed],"en",previous).map(x=>x.text))
      .toContain("$120");
    expect(checkNumbers("Sales $90","",[changed],"en",previous)).toEqual([]);
    const missing=fixture("net_sales","cents",null,0);
    expect(checkNumbers("Sales $90","",[missing],"en",compactEvidence([changed])).length)
      .toBeGreaterThan(0);
  });
  it("cannot infer units from arbitrary diagnostic objects or a forged catalog unit",()=>{
    const wrong=fixture("net_sales","count",12000);
    const unknown:AgentToolResult={source:"owner_initiatives",period:null,missing:[],
      initiative:{id:initiativeId},metricDetail:{id:metricId,metricKey:null,unit:null},
      metricEvaluation:{current:12000,target:10000,coverage:1}};
    expect(compactEvidence([wrong,unknown]).flatMap(x=>x.values)).toEqual([]);
    expect(checkNumbers("Sales $120","",[wrong,unknown],"en").length).toBe(1);
  });
  it("does not treat relative percentage targets as currencies",()=>{
    const base=fixture("net_sales","cents",12000);
    const relative:AgentToolResult={...base,
      metricEvaluation:null,
      metricDetail:{...base.metricDetail as object,targetKind:"relative_pct",target:15}};
    const typed=compactEvidence([relative]).flatMap(x=>x.values);
    expect(typed).toEqual(expect.arrayContaining([
      expect.objectContaining({value:1500,unit:"bps"}),
      expect.objectContaining({value:12000,unit:"cents"}),
    ]));
    expect(checkNumbers("Our goal is +15%","",[relative],"en")).toEqual([]);
    expect(checkNumbers("Our target was $0.15","",[relative],"en").length)
      .toBeGreaterThan(0);
  });
});
