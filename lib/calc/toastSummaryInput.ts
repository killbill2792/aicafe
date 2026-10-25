import Papa from "papaparse";
import {z} from "zod";
const integer=z.number().int().safe();
export const toastSummaryDraft=z.object({date:z.iso.date(),netSalesCents:integer,
 ordersCount:integer.nonnegative().nullable(),discountsCents:integer.nullable(),
 refundsCents:integer.nullable(),voidsCount:integer.nonnegative().nullable()}).strict();
export type ToastSummaryDraft=z.infer<typeof toastSummaryDraft>;
function ascii(value:string){return value.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632))
 .replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/[\u200e\u200f\u061c]/g,"");}
/** Parse digits as decimal strings, never round a floating-point monetary value. */
export function parseToastNumber(value:string,locale:string,money=true):number|null{
 let s=ascii(value).trim();if(!s)return null;
 const parts=new Intl.NumberFormat(locale).formatToParts(12345.6);
 const group=ascii(parts.find(p=>p.type==="group")?.value??",");
 const decimal=ascii(parts.find(p=>p.type==="decimal")?.value??".");
 s=s.replace(/[$€£\s\u00a0\u202f]/g,"");
 if(group!==decimal&&s.includes(group)){
  const parts=s.split(decimal),groups=parts[0].replace(/^-/,"").split(group);
  if(!/^\d{1,3}$/.test(groups[0])||groups.slice(1).some(g=>!/^\d{3}$/.test(g))||parts.slice(1).some(p=>p.includes(group)))throw Error("invalid_number");
  s=s.split(group).join("");
 }
 s=s.replace("٫",".").replaceAll("٬","");
 if(decimal!==".")s=s.split(decimal).join(".");
 if(!/^-?\d+(?:\.\d{1,2})?$/.test(s)||!money&&s.includes("."))throw Error("invalid_number");
 const negative=s.startsWith("-");if(negative)s=s.slice(1);
 const [whole,fraction=""]=s.split(".");
 const result=money?Number(whole)*100+Number(fraction.padEnd(2,"0")):Number(whole);
 const signed=negative?-result:result;
 if(!Number.isSafeInteger(signed)||!money&&signed<0)throw Error("invalid_number");
 return signed;
}
export function parseToastSummaryCsv(text:string,locale:string,fallbackDate:string):ToastSummaryDraft[]{
 const result=Papa.parse<Record<string,string>>(text,{header:true,skipEmptyLines:"greedy",transformHeader:h=>h.trim().toLowerCase()});
 if(result.errors.length||!result.data.length||result.data.length>31)throw Error("invalid_report");
 return result.data.map(row=>toastSummaryDraft.parse({
  date:row["business date"]||row["date"]||(result.data.length===1?fallbackDate:""),
  netSalesCents:parseToastNumber(row["net sales"]??"",locale),
  ordersCount:parseToastNumber(row["total orders"]??"",locale,false),
  discountsCents:parseToastNumber(row["discounts"]??"",locale),
  refundsCents:parseToastNumber(row["refunds"]??"",locale),
  voidsCount:parseToastNumber(row["voids"]??"",locale,false)
 }));
}
