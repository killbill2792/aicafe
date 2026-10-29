import "server-only";
import {z} from "zod";
import {ToolError} from "@/lib/ai/agent/toolErrors";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {getMenuControlCenter} from "@/lib/data/getMenuControlCenter";
import {readMetricDay} from "@/lib/data/metricDay.server";
import {computeMetric,type MetricDailyInput} from "@/lib/calc/metrics/catalog";
import {cafeToday} from "@/lib/metrics/core/clock";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {GOAL_METRICS,GOAL_MIN_DAYS,GOAL_MAX_DAYS,BASELINE_DAYS,MAX_GUARDRAILS,ITEM_METRICS,
  goalEffectSchema,goalMetricsFromRequest,baselineDatesFor,addDays,scoreGoal,
  type GoalEffect,type GoalObservation} from "@/lib/calc/goals/goalSpec";
import {goalTitle,goalPreview,goalMidRunText,goalReportText} from "@/lib/calc/goals/goalText";
import {registerLoopCapability} from "./engine";
import {readGoalCheckins} from "./goalCheckins.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {tallyCheckins,goalCheckinSchema} from "@/lib/calc/goals/goalSpec";

export const goalCapabilityId="leo.goal.v1";
const metric=z.enum(GOAL_METRICS);
export const goalInputSchema=z.strictObject({
  metric,itemId:z.uuid().nullable(),direction:z.enum(["up","down"]),
  targetKind:z.enum(["percent","absolute"]),target:z.number().finite().positive().max(1e9),
  days:z.number().int().min(GOAL_MIN_DAYS).max(GOAL_MAX_DAYS),
  guardrails:z.array(z.strictObject({metric,itemId:z.uuid().nullable(),
    direction:z.enum(["not_below","not_above"]),percent:z.number().finite().positive().max(100)})).max(MAX_GUARDRAILS),
  checkin:goalCheckinSchema.nullable().optional(),
}).refine(v=>v.targetKind!=="percent"||v.target<=500,"A percent target is at most 500%");
export type GoalInput=z.infer<typeof goalInputSchema>;

/** One café day's certified inputs, read once and shared by every metric. */
function dayReader(businessId:string,effect:GoalEffect){
  const itemIds=[...new Set(effect.metrics.flatMap(m=>m.itemId?[m.itemId]:[]))];
  const cache=new Map<string,Promise<MetricDailyInput>>();
  return (date:string)=>{
    if(!cache.has(date))cache.set(date,readMetricDay(businessId,date,
      {items:itemIds.length>0,hours:false,ingredientIds:[],itemIds,costs:false}));
    return cache.get(date)!;
  };
}
function valueOf(effect:GoalEffect,id:string,day:MetricDailyInput){
  const m=effect.metrics.find(x=>x.id===id)!;
  const r=computeMetric(m.metricKey,m.itemId?{itemId:m.itemId}:{},day);
  return {value:r.value,coverage:r.value===null?0:r.coverage};
}

export const goalCapability=registerLoopCapability({
  id:goalCapabilityId,version:1,inputSchema:goalInputSchema,effectSchema:goalEffectSchema,
  proposalDescription:"Draft an inert goal for the owner to confirm. Tracking a goal changes nothing in the café or the POS.",
  dependencyScope:(effect)=>({version:1,kind:"goal",metric:effect.metrics[0].metricKey,itemId:effect.metrics[0].itemId}),
  simulate:async(scope,input)=>{
    const client=await createServerSupabaseClient();
    const {data:{user}}=await client.auth.getUser();
    if(!user||user.id!==scope.ownerUserId)throw new ToolError("unauthorized");
    if(await getActiveBusinessId(user.id)!==scope.businessId)throw new ToolError("scope_mismatch");
    const [{data:membership},{data:business}]=await Promise.all([
      client.from("memberships").select("role").eq("business_id",scope.businessId).eq("user_id",user.id).maybeSingle(),
      client.from("businesses").select("currency,timezone,is_demo").eq("id",scope.businessId).maybeSingle(),
    ]);
    if(membership?.role!=="owner"||business?.is_demo||!business?.timezone)throw new ToolError("unauthorized");
    const currency=typeof business.currency==="string"&&/^[A-Z]{3}$/.test(business.currency)?business.currency:null;
    const all=[{metric:input.metric,itemId:input.itemId},...input.guardrails];
    for(const m of all)if(ITEM_METRICS.has(m.metric)!==(m.itemId!==null))
      throw new ToolError("validation",ITEM_METRICS.has(m.metric)?"Choose which menu item to measure.":"This measure is for the whole café, not one item.");
    const ids=[...new Set(all.flatMap(m=>m.itemId?[m.itemId]:[]))];
    const names=new Map<string,string>();
    if(ids.length){
      const menu=(await getMenuControlCenter()).filter(x=>x.active&&ids.includes(x.id));
      if(menu.length!==ids.length)throw new ToolError("not_found");
      for(const item of menu)names.set(item.id,item.name);
    }
    const metrics=goalMetricsFromRequest(input,names);
    const today=cafeToday(business.timezone);
    const effect=goalEffectSchema.parse({
      title:goalTitle(metrics[0],scope.locale,currency),metrics,days:input.days,proposedOn:today,
      baselineFrom:addDays(today,-BASELINE_DAYS),baselineTo:addDays(today,-1),currency,
      ...(input.checkin?{checkin:input.checkin}:{}),
    });
    return {effect:{...effect},baseline:{source:"metric_catalog",preview:goalPreview(effect,scope.locale)},
      monitorSpec:{durationDays:input.days,metricScope:"goal:"+metrics[0].metricKey+(metrics[0].itemId?":"+metrics[0].itemId:"")}};
  },
  // Tracking a goal has no side effect: it starts monitoring from tomorrow.
  commit:async()=>({status:"verified",evidenceSource:"goal_tracking"}),
  monitor:async(scope,effect,businessDate)=>{
    const read=dayReader(scope.businessId,effect);
    const today=await read(businessDate);
    const observation:GoalObservation={values:{},baseline:{}};
    const baseDates=baselineDatesFor(businessDate,effect.baselineFrom,effect.baselineTo);
    const baseDays=await Promise.all(baseDates.map(async d=>({date:d,day:await read(d)})));
    for(const m of effect.metrics){
      observation.values[m.id]=valueOf(effect,m.id,today);
      observation.baseline[m.id]=baseDays.map(({date,day})=>({date,...valueOf(effect,m.id,day)}));
    }
    return {businessDate,observation,source:"metric_catalog"};
  },
  report:async(scope,effect,samples,windowComplete,window)=>{
    const outcome=scoreGoal(effect,samples,windowComplete,window);
    // Messages are capped at 1200 characters; the caveat sentence is the last part.
    // Check-in answers are qualitative: reported next to the numbers, never scored.
    const checkins=effect.checkin&&outcome.status!=="in_progress"&&window?.proposalId
      ?await readGoalCheckins(createAdminSupabaseClient(),scope.businessId,window.proposalId).then(tallyCheckins).catch(()=>undefined):undefined;
    const full=outcome.status==="in_progress"?goalMidRunText(effect,outcome,scope.locale):goalReportText(effect,outcome,scope.locale,checkins);
    const text=full.length<=1200?full:full.slice(0,1199)+"…";
    return {status:outcome.status,recommendation:outcome.recommendation,source:"metric_catalog",
      result:{title:effect.title,evaluationStatus:outcome.evaluation.status,asOf:outcome.asOf,
        results:outcome.evaluation.results},
      ...(outcome.status==="in_progress"?{midRunText:text}:{}),
      delivery:{agentId:"leo" as const,taskKind:"goal_report" as const,entityType:"goal",
        entityId:effect.metrics[0].metricKey+(effect.metrics[0].itemId?":"+effect.metrics[0].itemId:""),
        confidence:outcome.status==="complete"?"high" as const:"low" as const,
        payload:{itemName:effect.title,goalTitle:effect.title,outcomeStatus:outcome.status,
          evaluationStatus:outcome.evaluation.status,recommendation:outcome.recommendation,text},
        evidence:[{source:"metric_catalog",facts:{evaluationStatus:outcome.evaluation.status,nonCausal:true}}],
        threadText:text}};
  },
});
