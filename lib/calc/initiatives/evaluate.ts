/** Pure, evidence-first goal/experiment evaluation. No source reads or model input. */
export type Comparison = "gte" | "lte";
export type GoalMetric = {
  id:string; role:"primary"|"guardrail"; comparator:Comparison;
  targetKind:"absolute"|"relative_pct"; target:number;
  baseline:Array<{date:string;value:number|null;coverage:number}>;
  test:Array<{date:string;value:number|null;coverage:number}>;
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
/** For each observed test day compare against the nearest recorded baseline of same weekday. */
export function evaluateInitiative(
  metrics:GoalMetric[],asOf:string,endsOn:string,minCoverage=0.8,kind:"goal"|"experiment"="experiment",
):Evaluation {
  const results:Evaluation["results"]={};
  let insufficient=false,primaryMet=true,guardrailBreach=false;
  for(const metric of metrics){
    const tested=metric.test.filter(r=>r.date<=asOf&&r.date<=endsOn);
    const covered=tested.filter(r=>r.value!==null&&r.coverage>=minCoverage);
    const validPairs=covered.flatMap(row=>{
      const candidates=metric.baseline.filter(b=>weekday(b.date)===weekday(row.date)&&b.value!==null&&b.coverage>=minCoverage&&b.date<row.date)
        .sort((a,b)=>b.date.localeCompare(a.date));
      return candidates.length?[{test:row.value!,base:candidates[0].value!}]:[];
    });
    const coverage=tested.length?validPairs.length/tested.length:0;
    const baseline=validPairs.length?average(validPairs.map(p=>p.base)):null;
    const current=validPairs.length?average(validPairs.map(p=>p.test)):null;
    const target=baseline===null?null:metric.targetKind==="relative_pct"?
      baseline*(1+metric.target/100):metric.target;
    const met=current===null||target===null?null:
      metric.comparator==="gte"?current>=target:current<=target;
    results[metric.id]={baseline,current,target,coverage,met};
    if(coverage<minCoverage||met===null){insufficient=true;continue;}
    if(metric.role==="primary"&&!met)primaryMet=false;
    if(metric.role==="guardrail"&&!met)guardrailBreach=true;
  }
  if(metrics.length===0||!metrics.some(m=>m.role==="primary")||insufficient)
    return {status:"insufficient_data",recommendation:"none",results};
  const done=asOf>=endsOn;
  const positive=primaryMet&&!guardrailBreach;
  const status:EvaluationStatus=done?(positive?"met":"missed"):(positive?"on_track":"off_track");
  const recommendation:Recommendation=positive?"keep":
    guardrailBreach?(kind==="experiment"?"revert":"adjust"):
    done?"adjust":"adjust";
  return {status,recommendation,results};
}
