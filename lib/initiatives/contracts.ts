import { z } from "zod";
import { metricCatalog, metricKeySchema } from "@/lib/calc/metrics/catalog";

export const initiativeStatusSchema = z.enum(["proposed","active","completed","cancelled","reverted"]);
export const evaluationStatusSchema = z.enum(["on_track","off_track","met","missed","insufficient_data"]);
export const recommendationSchema = z.enum(["keep","revert","adjust","extend","none"]);
export const initiativeMetricSchema = z.strictObject({
  role:z.enum(["primary","guardrail"]),
  source:z.enum(["computed","checkin"]),
  metricKey:metricKeySchema.nullable(),
  params:z.record(z.string(),z.unknown()),
  comparator:z.enum(["gte","lte"]),
  targetKind:z.enum(["absolute","relative_pct"]),
  target:z.number().finite(),
  checkinQuestion:z.string().min(1).max(300).nullable(),
  checkinAudience:z.enum(["owner","staff"]).nullable(),
  dataGap:z.string().max(300).nullable(),
}).superRefine((metric,ctx)=>{
  if(metric.source==="computed"){
    if(!metric.metricKey||metric.checkinQuestion!==null||metric.checkinAudience!==null)
      ctx.addIssue({code:"custom",message:"computed metric requires key and no question"});
    else if(!metricCatalog[metric.metricKey].paramsSchema.safeParse(metric.params).success)
      ctx.addIssue({code:"custom",message:"invalid metric parameters"});
  } else if(metric.metricKey!==null||!metric.checkinQuestion||!metric.checkinAudience) {
    ctx.addIssue({code:"custom",message:"unavailable metric requires a check-in question"});
  }
});
export const proposeInitiativeSchema=z.strictObject({
  threadId:z.uuid(),
  kind:z.enum(["goal","experiment"]),
  title:z.string().trim().min(1).max(160),
  changeDescription:z.string().max(1000),
  changeSpec:z.record(z.string(),z.unknown()),
  adapterId:z.string().max(80).nullable(),
  startsOn:z.iso.date(),
  endsOn:z.iso.date(),
  baselineFrom:z.iso.date(),
  baselineTo:z.iso.date().nullable(),
  checkinCadence:z.enum(["daily","every_3_days","weekly","end_only"]),
  metrics:z.array(initiativeMetricSchema).min(1).max(12),
}).superRefine((value,ctx)=>{
  const start=Date.parse(value.startsOn+"T12:00:00Z"),end=Date.parse(value.endsOn+"T12:00:00Z");
  const length=(end-start)/86400000+1;
  if(length<7||length>92||!Number.isInteger(length))
    ctx.addIssue({code:"custom",message:"monitoring window must contain 7 to 92 days"});
  if(value.baselineFrom>=value.startsOn||
     (value.baselineTo!==null&&(value.baselineTo<value.baselineFrom||value.baselineTo>=value.startsOn)))
    ctx.addIssue({code:"custom",message:"baseline must predate the change"});
  if(value.kind==="goal"&&(value.changeDescription.trim()!==""||value.adapterId!==null))
    ctx.addIssue({code:"custom",message:"goal has no operational change"});
  if(!value.metrics.some(m=>m.role==="primary"))
    ctx.addIssue({code:"custom",message:"initiative requires a primary metric"});
});
export type ProposeInitiative=z.output<typeof proposeInitiativeSchema>;
export type InitiativeMetricInput=ProposeInitiative["metrics"][number];
export type InitiativeScope={businessId:string;ownerUserId:string};
export type InitiativeRow={
  id:string;business_id:string;owner_user_id:string;thread_id:string;
  kind:"goal"|"experiment";title:string;change_description:string;
  change_spec:Record<string,unknown>;adapter_id:string|null;
  starts_on:string;ends_on:string;baseline_from:string;baseline_to:string|null;
  checkin_cadence:"daily"|"every_3_days"|"weekly"|"end_only";
  status:z.infer<typeof initiativeStatusSchema>;locale:"en"|"es"|"ar";
  revision:number;monitor_checked_at:string|null;created_at:string;updated_at:string;
};
export type MetricRow={
  id:string;initiative_id:string;role:"primary"|"guardrail";source:"computed"|"checkin";
  metric_key:z.infer<typeof metricKeySchema>|null;
  params:Record<string,unknown>;comparator:"gte"|"lte";
  target_kind:"absolute"|"relative_pct";target:number;
  checkin_question:string|null;checkin_audience:"owner"|"staff"|null;data_gap:string|null;
};
export type ObservationRow={
  metric_id:string;business_date:string;value:number|null;coverage:number;
  source:"computed"|"owner_checkin"|"staff_checkin";note:string|null;
};
export type EvaluationRow={
  id:string;initiative_id:string;as_of:string;
  status:z.infer<typeof evaluationStatusSchema>;
  results:Record<string,unknown>;recommendation:z.infer<typeof recommendationSchema>;
  digest:string;created_at:string;
};
