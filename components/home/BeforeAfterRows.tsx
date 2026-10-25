"use client";
import type {CardLocale,DiffField,CardValue} from "@/lib/format/values";
import {formatCardField,formatCardValue} from "@/lib/format/values";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
const messages={en,es,ar} as const;
export type ApprovalPreviewRow=DiffField|{label:string;before:string;after:string};
function isTyped(row:ApprovalPreviewRow):row is DiffField{return "field" in row;}
export default function BeforeAfterRows({rows,locale,currency="USD"}:{
 rows:readonly ApprovalPreviewRow[];locale:CardLocale;currency?:string;
}){
 const copy=messages[locale].StaffApprovalCard;
 const render=(value:CardValue|null|undefined)=>value===null||value===undefined?null:
   formatCardValue(value,locale,currency);
 return <div className="mt-3 space-y-3" dir={locale==="ar"?"rtl":"ltr"}>
  {rows.map((r,i)=>{
   const before=isTyped(r)?render(r.before):r.before;
   const after=isTyped(r)?render(r.after):r.after;
   const label=isTyped(r)?formatCardField(r.field,r.label,locale):r.label;
   return <div key={isTyped(r)?r.field:i} className="min-w-0 rounded-xl border border-line p-3">
    <p className="break-words text-[17px] font-bold">{label}</p>
    <div className="mt-2 flex flex-wrap items-start gap-3 text-[17px]">
     {before!==null&&before!==undefined&&<div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
      <p className="text-[17px] text-ink-muted">{copy.before}</p><p>{before}</p></div>}
     {before!==null&&before!==undefined&&after!==null&&after!==undefined&&
      <span aria-hidden="true" className="self-center text-ink-muted">{locale==="ar"?"←":"→"}</span>}
     {after!==null&&after!==undefined&&<div className="min-w-0 flex-1 whitespace-pre-wrap break-words">
      <p className="text-[17px] text-ink-muted">{copy.after}</p><p>{after}</p></div>}
    </div>
   </div>;
  })}
 </div>;
}
