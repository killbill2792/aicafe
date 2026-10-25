"use client";
import {useState} from "react";
import type {z} from "zod";
import {clarifyBlockSchema} from "@/lib/ai/conversations/contracts";
type Block=z.infer<typeof clarifyBlockSchema>;
type Copy={clarifyOther:string;clarifySend:string;clarifyYouChose:string;clarifySkipped:string;clarifyOtherPlaceholder:string};
export default function ClarifyCard({block,locale,copy,state,choice,disabled,onSend}:{
 block:Block;locale:"en"|"es"|"ar";copy:Copy;state:"hidden"|"active"|"chosen"|"skipped";choice:string|null;
 disabled:boolean;onSend:(text:string)=>void;
}){
 const [other,setOther]=useState(false),[typed,setTyped]=useState("");
 if(state==="hidden")return null;
 if(state==="chosen")return <p dir={locale==="ar"?"rtl":"ltr"} className="text-[17px] text-ink-muted">{copy.clarifyYouChose.replace("{choice}",choice??"")}</p>;
 if(state==="skipped")return <p className="text-[17px] text-ink-muted">{copy.clarifySkipped}</p>;
 return <section dir={locale==="ar"?"rtl":"ltr"} className="space-y-3 rounded-2xl border border-line bg-surface p-3">
   <h3 className="text-[17px] font-semibold text-ink">{block.question}</h3>
   <div className="space-y-2">{block.options.map((o,i)=><button key={o.value} type="button" disabled={disabled}
     onClick={()=>onSend(o.label)} className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-line bg-surface2 px-3 text-start text-[17px] font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
     <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm">{String.fromCharCode(65+i)}</span><span>{o.label}</span>
   </button>)}</div>
   {block.allowOther&&(other?<form className="space-y-2" onSubmit={e=>{e.preventDefault();if(typed.trim()&&!disabled)onSend(typed.trim());}}>
     <input maxLength={200} value={typed} onChange={e=>setTyped(e.target.value)} aria-label={copy.clarifyOtherPlaceholder}
       placeholder={copy.clarifyOtherPlaceholder} className="min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-[17px] text-ink"/>
     <button type="submit" disabled={disabled||!typed.trim()} className="min-h-12 w-full rounded-xl bg-accent px-4 text-[17px] font-bold text-on-accent disabled:opacity-50">{copy.clarifySend}</button>
   </form>:<button type="button" disabled={disabled} onClick={()=>setOther(true)} className="min-h-12 w-full text-start text-[17px] font-semibold text-good focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">{copy.clarifyOther}</button>)}
 </section>;
}
