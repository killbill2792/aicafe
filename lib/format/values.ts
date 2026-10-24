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
export type DiffField={field:string;label:string;before:CardValue|null;after:CardValue|null};
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
export function formatCardField(field:string,label:string,locale:CardLocale):string{
 const labels=messages[locale].CardValues as Record<string,string>;
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
  case "moneyRate":return money(value.cents)+"/"+t["per"+value.per.charAt(0).toUpperCase()+value.per.slice(1) as keyof typeof t];
  case "percent":return new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(value.bps/100)+"%";
  case "count":return new Intl.NumberFormat(locale).format(value.n)+(value.unit?" "+value.unit:"");
  case "duration":return new Intl.NumberFormat(locale).format(value.minutes)+" "+t.minutes;
  case "time":return value.hhmm;
  case "date":return new Intl.DateTimeFormat(locale,{year:"numeric",month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(value.iso+"T12:00:00Z"));
  case "timeRange":return (value.date?formatCardValue({kind:"date",iso:value.date},locale,currency)+" ":"")+value.start+"–"+value.end;
  case "text":return value.text;
  case "bool":return value.value?t.yes:t.no;
  case "missing":return t[value.reason];
 }
}
