/** Pure, evidence-first goal/experiment evaluation. No source reads or model input. */
export type Comparison = "gte" | "lte";
export type GoalMetric = {
  id:string; role:"primary"|"guardrail"; comparator:Comparison;
  targetKind:"absolute"|"relative_pct"; target:number;source?:"computed"|"checkin";
  baseline:Array<{date:string;value:number|null;coverage:number}>;
  test:Array<{date:string;value:number|null;coverage:number}>;
  /** Required sampling dates, including those with no row in storage. */
  expectedTestDates?:string[];
};
export type EvaluationStatus = "on_track"|"off_track"|"met"|"missed"|"insufficient_data";
export type Recommendation = "keep"|"revert"|"adjust"|"extend"|"none";
export type Evaluation = {
  status:EvaluationStatus; recommendation:Recommendation; results:Record<string,{
    baseline:number|null;current:number|null;target:number|null;coverage:number;met:boolean|null;
  }>;
};
const weekday = (s:string)=>new Date(s+"T12:00:00Z").getUTCDay();
const average = (nums:number[])=>nums.reduce((a,b)=>a+b,0)/nums.length;
/** Match every test day to the closest covered baseline of the same weekday. */
export function evaluateInitiative(
  metrics:GoalMetric[],asOf:string,endsOn:string,minCoverage=0.8,kind:"goal"|"experiment"="experiment",
):Evaluation {
  const results:Evaluation["results"]={};
  let insufficient=false,primaryMet=true,guardrailBreach=false;
  for(const metric of metrics){
    const observed=metric.test.filter(r=>r.date<=asOf&&r.date<=endsOn);
    const tested=metric.expectedTestDates?.length ? metric.expectedTestDates
      .filter(date=>date<=asOf&&date<=endsOn)
      .map(date=>observed.find(r=>r.date===date)??{date,value:null,coverage:0}) : observed;
    const covered=tested.filter(r=>r.value!==null&&r.coverage>=minCoverage);
    const validPairs=covered.flatMap(row=>{
      if(metric.source==="checkin"&&metric.targetKind==="absolute")
        return [{test:row.value!,base:row.value!}]; // explicit owner value, no inferred baseline
      const candidates=metric.baseline.filter(b=>weekday(b.date)===weekday(row.date)&&b.value!==null&&b.coverage>=minCoverage&&b.date<row.date)
        .sort((a,b)=>b.date.localeCompare(a.date));
      return candidates.length?[{test:row.value!,base:candidates[0].value!}]:[];
    });
    const coverage=tested.length?validPairs.length/tested.length:0;
    const baseline=validPairs.length?average(validPairs.map(p=>p.base)):null;
    const current=validPairs.length?average(validPairs.map(p=>p.test)):null;
    const target=metric.targetKind==="absolute"?metric.target:baseline===null?null:baseline*(1+metric.target/100);
    const met=current===null||target===null?null:
      metric.comparator==="gte"?current>=target:current<=target;
    results[metric.id]={baseline:metric.source==="checkin"?null:baseline,current,target,coverage,met};
    if(coverage<minCoverage||met===null){insufficient=true;continue;}
    if(metric.role==="primary"&&!met)primaryMet=false;
    if(metric.role==="guardrail"&&!met)guardrailBreach=true;
  }
  // A proven guardrail violation is actionable even when another series is incomplete.
  if(guardrailBreach) return {status:asOf>=endsOn?"missed":"off_track",
    recommendation:kind==="experiment"?"revert":"adjust",results};
  if(metrics.length===0||!metrics.some(m=>m.role==="primary")||insufficient)
    return {status:"insufficient_data",recommendation:"none",results};
  const done=asOf>=endsOn;
  const positive=primaryMet&&!guardrailBreach;
  const status:EvaluationStatus=done?(positive?"met":"missed"):(positive?"on_track":"off_track");
  const recommendation:Recommendation=positive?"keep":
    guardrailBreach?(kind==="experiment"?"revert":"adjust"):"adjust";
  return {status,recommendation,results};
}
