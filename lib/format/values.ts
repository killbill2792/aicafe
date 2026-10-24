import {z} from "zod";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";

export const cardValueSchema=z.discriminatedUnion("kind",[
 z.strictObject({kind:z.literal("money"),cents:z.number().int().safe()}),
 z.strictObject({kind:z.literal("moneyRate"),cents:z.number().int().safe(),per:z.enum(["hour","day","week","month","item"])}),
 z.strictObject({kind:z.literal("percent"),bps:z.number().int().safe()}),
 z.strictObject({kind:z.literal("count"),n:z.number().int().safe(),unit:z.string().max(80).optional()}),
 z.strictObject({kind:z.literal("duration"),minutes:z.number().int().safe()}),
 z.strictObject({kind:z.literal("time"),hhmm:z.string().regex(/^([01]\\d|2[0-3]):[0-5]\\d$/)}),
 z.strictObject({kind:z.literal("date"),iso:z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/)}),
 z.strictObject({kind:z.literal("timeRange"),date:z.string().optional(),start:z.string(),end:z.string()}),
 z.strictObject({kind:z.literal("text"),text:z.string().max(6000)}),
 z.strictObject({kind:z.literal("bool"),value:z.boolean()}),
 z.strictObject({kind:z.literal("missing"),reason:z.enum(["noWage","noRole","noPhone","none"])}),
]);
export type CardValue=z.infer<typeof cardValueSchema>;
export const diffFieldSchema=z.strictObject({field:z.string().max(160),label:z.string().max(220),
 before:cardValueSchema.nullable(),after:cardValueSchema.nullable()});
export type DiffField=z.infer<typeof diffFieldSchema>;
export type FieldValue={field:string;label:string;value:CardValue};
/** Stable keys, never locale-specific strings, decide whether a field changed. */
export function diffFields(before:readonly FieldValue[],after:readonly FieldValue[]):DiffField[]{
 const old=new Map(before.map(v=>[v.field,v] as const));
 const next=new Map(after.map(v=>[v.field,v] as const));
 const fields=[...new Set([...old.keys(),...next.keys()])];
 return fields.flatMap(field=>{
  const a=old.get(field),b=next.get(field);
  if(JSON.stringify(a?.value??null)===JSON.stringify(b?.value??null))return [];
  return [{field,label:b?.label??a?.label??field,before:a?.value??null,after:b?.value??null}];
 });
}
export type CardLocale="en"|"es"|"ar";
const messages={en,es,ar} as const;
const ruleTranslationKeys:Record<string,string>={
 meal_break_enabled:"mealBreak",meal_break_minutes:"mealMinutes",
 meal_break_after_minutes:"mealAfter",rest_break_enabled:"paidRest",
 rest_break_minutes:"restMinutes",rest_break_every_minutes:"restEvery",
 weekly_ot_enabled:"weeklyOvertime",weekly_ot_after_minutes:"weeklyAfter",
 ot_multiplier_bp:"multiplier",daily_ot_enabled:"dailyOvertime",
 daily_ot_after_minutes:"dailyAfter",max_shift_enabled:"longestShift",
 max_shift_minutes:"longestMinutes",min_shift_enabled:"shortestShift",
 min_shift_minutes:"shortestMinutes",min_rest_enabled:"betweenShifts",
 min_rest_minutes:"betweenMinutes",coverage_enabled:"minimumCoverage",
 min_headcount:"peopleWhileOpen",prep_minutes_before_open:"prepBeforeOpen",
 prep_minutes_after_close:"prepAfterClose",
};
const weekdayKeys=["sun","mon","tue","wed","thu","fri","sat"] as const;
export function formatCardField(field:string,label:string,locale:CardLocale):string{
 const catalog=messages[locale];
 if(field.startsWith("rule:")){
  const key=ruleTranslationKeys[field.slice(5)];
  return key?(catalog.StaffSchedule as Record<string,string>)[key]??label:label;
 }
 if(field.startsWith("schedule:"))
  return catalog.StaffApprovalCard.week+" "+field.slice("schedule:".length);
 if(field.startsWith("availability:")){
  const suffix=field.slice("availability:".length);
  const day=Number(suffix);
  if(/^\\d$/.test(suffix)&&day>=0&&day<=6)
   return catalog.SchedulingAvailability[weekdayKeys[day]];
  return suffix; // date-specific absence, not the generic availability label
 }
 // Contextual labels must not be flattened to "Rule" or "Shift":
 // owners must see which rule and whose shift the card changes.
 if(field==="rule"||field==="shift"||field==="schedule"||field==="availability")
  return label;
 const labels=catalog.CardValues as Record<string,string>;
 const key="field"+field.charAt(0).toUpperCase()+field.slice(1);
 return labels[key]??label;
}
/** The one formatter used by owner approval cards. A missing value is never a zero or dash. */
export function formatCardValue(value:CardValue,locale:CardLocale,currency:string):string{
 const t=messages[locale].CardValues;
 const money=(cents:number)=>new Intl.NumberFormat(locale==="ar"?"en-US":locale,{
  style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(cents/100);
 switch(value.kind){
  case "money":return money(value.cents);
  case "moneyRate":{
    const unit={hour:t.perHour,day:t.perDay,week:t.perWeek,month:t.perMonth,item:t.perItem}[value.per];
    return money(value.cents)+"/"+unit;
  }
  case "percent":return new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(value.bps/100)+"%";
  case "count":{
   const unit=value.unit==="days"?
     {en:"days",es:"días",ar:"أيام"}[locale]:value.unit;
   return new Intl.NumberFormat(locale).format(value.n)+(unit?" "+unit:"");
  }
  case "duration":return new Intl.NumberFormat(locale).format(value.minutes)+" "+t.minutes;
  case "time":return value.hhmm;
  case "date":return new Intl.DateTimeFormat(locale,{year:"numeric",month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(value.iso+"T12:00:00Z"));
  case "timeRange":return (value.date?formatCardValue({kind:"date",iso:value.date},locale,currency)+" ":"")+value.start+"–"+value.end;
  case "text":return value.text;
  case "bool":return value.value?t.yes:t.no;
  case "missing":return t[value.reason];
 }
}
