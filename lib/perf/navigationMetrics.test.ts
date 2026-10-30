import {describe,expect,it} from "vitest";
import {perfRoute,percentile,rscStats,safeMetric} from "./navigationMetrics";
describe("performance event safety and measurement",()=>{
  it("classifies all main locales and nested screens without returning identifiers",()=>{
    const paths=["/en","/es/money","/ar/menu/private-item","/en/operations","/ar/staff",
      "/es/more","/en/more/cafe-profile","/es/more/toast"];
    expect(paths.map(p=>perfRoute(p))).toEqual(["home","money-recovery","menu","operations",
      "staff","more","settings","toast"]);
    expect(perfRoute("/en/money","profit")).toBe("money-profit");
    expect(perfRoute("/en/login")).toBeNull();
  });
  it("counts only RSC fetches from the same origin and time window",()=>{
    const row=(name:string,startTime:number,responseStart:number,initiatorType="fetch")=>
      ({name,startTime,responseStart,initiatorType});
    expect(rscStats([
      row("https://cafe.test/en?_rsc=private",20,80),
      row("https://cafe.test/en?_rsc=other",30,130),
      row("https://cafe.test/api/chat?prompt=private",35,40),
      row("https://else.test/en?_rsc=x",40,50),
      row("https://cafe.test/en?_rsc=old",1,10),
      row("https://cafe.test/en?_rsc=img",45,55,"img"),
    ],10,100,"https://cafe.test")).toEqual({rscRequests:2,ttfbMs:60});
  });
  it("fails closed for user content, unexpected fields and invalid timing",()=>{
    const valid={route:"staff",action:"link",session:"client",device:"phone",status:"usable",
      trace:"0123456789abcdef",feedbackMs:null,pendingMs:20,usableMs:901,ttfbMs:400,rscRequests:2};
    expect(safeMetric(valid)).toEqual(valid);
    expect(safeMetric({...valid,email:"private"})).toBeNull();
    expect(safeMetric({...valid,pathname:"/staff/private"})).toBeNull();
    expect(safeMetric({...valid,trace:"user@example.com"})).toBeNull();
    expect(safeMetric({...valid,usableMs:-2})).toBeNull();
    expect(safeMetric({...valid,rscRequests:101})).toBeNull();
    expect(safeMetric({...valid,status:"timeout",usableMs:null})).not.toBeNull();
  });
  it("reports nearest rank p50 p75 p95 and no percentile without samples",()=>{
    const xs=[300,1200,100,400,200,700,800,500,600,900];
    expect([percentile(xs,0.5),percentile(xs,0.75),percentile(xs,0.95)])
      .toEqual([500,800,1200]);
    expect(percentile([],0.95)).toBeNull();
  });
});
