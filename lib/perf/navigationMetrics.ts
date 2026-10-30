/** Only allowlisted categories and numbers may reach production logs. */
export const ROUTES = ["home","money-recovery","money-profit","menu","operations","staff","more","settings","toast","chat-start"] as const;
export type PerfRoute = typeof ROUTES[number];
export type NavMetric = {
  route: PerfRoute; action: "initial"|"link"|"period"|"money-view";
  session: "document"|"client"; device: "phone"|"desktop"; status: "usable"|"timeout";
  trace?: string; feedbackMs: number|null; pendingMs: number|null;
  usableMs: number|null; ttfbMs: number|null; rscRequests: number;
};
export const TRACE_COOKIE = "cp_perf_trace";

export function perfRoute(path: string, view?: string|null): PerfRoute|null {
  const parts=path.split("/").filter(Boolean);
  if (["en","es","ar"].includes(parts[0])) parts.shift();
  switch (parts[0]??"") {
    case "": return "home";
    case "money": return view==="profit"?"money-profit":"money-recovery";
    case "menu": return "menu";
    case "operations": return "operations";
    case "staff": return "staff";
    case "more": return parts[1]==="toast"?"toast":parts[1]?"settings":"more";
    default: return null;
  }
}
/** Bucket a Money view switch by the destination rather than the previously rendered tab. */
export function perfDestinationRoute(
  path:string, currentView:string|null, action:"link"|"period"|"money-view",
  selectedView?:string,
):PerfRoute|null {
  if(action==="money-view"&&selectedView!=="recovery"&&selectedView!=="profit")return null;
  return perfRoute(path,action==="money-view"?selectedView:currentView);
}
export type ResourceSample=Pick<PerformanceResourceTiming,"name"|"initiatorType"|"startTime"|"responseStart">;
export function rscStats(entries:readonly ResourceSample[], from:number,to:number,origin:string) {
  const samples=entries.filter((e)=>{
    if(e.initiatorType!=="fetch"||e.startTime<from||e.startTime>to)return false;
    try {const u=new URL(e.name);return u.origin===origin&&u.searchParams.has("_rsc");}
    catch{return false;}
  });
  const first=samples[0];
  return {rscRequests:samples.length,
    ttfbMs:first&&first.responseStart>=first.startTime
      ?Math.round(first.responseStart-first.startTime):null};
}
const ms=(x:unknown):x is number=>typeof x==="number"&&Number.isFinite(x)&&x>=0&&x<=120000;
const duration=(x:unknown):x is number|null=>x===null||ms(x);
export function safeMetric(raw:unknown):NavMetric|null {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const v=raw as Record<string,unknown>;
  const keys=["route","action","session","device","status","trace","feedbackMs","pendingMs","usableMs","ttfbMs","rscRequests"];
  if(Object.keys(v).some(k=>!keys.includes(k))||
    !ROUTES.includes(v.route as PerfRoute)||
    !["initial","link","period","money-view"].includes(v.action as string)||
    !["document","client"].includes(v.session as string)||
    !["phone","desktop"].includes(v.device as string)||
    !["usable","timeout"].includes(v.status as string)||
    !duration(v.feedbackMs)||!duration(v.pendingMs)||!duration(v.usableMs)||!duration(v.ttfbMs)||
    typeof v.rscRequests!=="number"||!Number.isInteger(v.rscRequests)||(v.rscRequests as number)<0||(v.rscRequests as number)>100||
    (v.trace!==undefined&&(typeof v.trace!=="string"||!/^[a-f0-9]{16}$/.test(v.trace)))||
    (v.status==="usable"&&v.usableMs===null)||
    (v.status==="timeout"&&v.usableMs!==null))return null;
  return {route:v.route as PerfRoute,action:v.action as NavMetric["action"],
    session:v.session as NavMetric["session"],device:v.device as NavMetric["device"],
    status:v.status as NavMetric["status"],
    ...(v.trace===undefined?{}:{trace:v.trace as string}),
    feedbackMs:v.feedbackMs as number|null,pendingMs:v.pendingMs as number|null,
    usableMs:v.usableMs as number|null,ttfbMs:v.ttfbMs as number|null,
    rscRequests:v.rscRequests as number};
}
export function percentile(values:readonly number[],p:0.5|0.75|0.95):number|null {
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.ceil(p*sorted.length)-1];
}
