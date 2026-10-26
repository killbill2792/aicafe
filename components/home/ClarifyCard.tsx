"use client";
import {useState} from "react";
import type {z} from "zod";
import {clarifyBlockSchema} from "@/lib/ai/conversations/contracts";
import {parseOwnerDecimal} from "@/lib/calc/localeDecimal";
import {saveUsageEntry} from "@/lib/actions/pantry";
type Block=z.infer<typeof clarifyBlockSchema>;
type Copy={clarifyOther:string;clarifySend:string;clarifyYouChose:string;clarifySkipped:string;clarifyOtherPlaceholder:string;clarifyFillError:string};
export default function ClarifyCard({block,locale,copy,state,choice,disabled,onSend}:{
 block:Block;locale:"en"|"es"|"ar";copy:Copy;state:"hidden"|"active"|"chosen"|"skipped";choice:string|null;
 disabled:boolean;onSend:(text:string)=>void;
}){
 const [other,setOther]=useState(false),[typed,setTyped]=useState("");
 const [amounts,setAmounts]=useState<Record<string,string>>({});
 const [selectedUnits,setSelectedUnits]=useState<Record<string,string>>({});
 const [busy,setBusy]=useState(false),[failure,setFailure]=useState(false);
 if(state==="hidden")return null;
 if(state==="chosen")return <p dir={locale==="ar"?"rtl":"ltr"} className="text-[17px] text-ink-muted">{copy.clarifyYouChose.replace("{choice}",choice??"")}</p>;
 if(state==="skipped")return <p className="text-[17px] text-ink-muted">{copy.clarifySkipped}</p>;
 if(block.kind==="fill"){
   const save=async()=>{
     if(disabled||busy)return;
     const values=block.fields.map(f=>({f,quantity:parseOwnerDecimal(amounts[f.key]??"",locale),
       unit:selectedUnits[f.key]??f.defaultUnit}));
     if(values.some(v=>v.quantity===null||v.quantity<=0)){setFailure(true);return;}
     setBusy(true);setFailure(false);
     try{
       for(const entry of values){
         const match=entry.f.key.match(/^(endCount|purchase):([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/i);
         if(!match)throw Error("invalid_field");
         if(match[1]==="endCount"){
           const result=await saveUsageEntry("count",{ingredientId:match[2],date:match[3],
             quantity:entry.quantity!,unit:entry.unit});
           if(!result.ok)throw Error("save_failed");
         }
       }
       onSend(values.map(v=>v.f.label+": "+
         new Intl.NumberFormat(locale,{maximumFractionDigits:4}).format(v.quantity!)+" "+v.unit).join("; "));
     }catch{setFailure(true);}finally{setBusy(false);}
   };
   return <section dir={locale==="ar"?"rtl":"ltr"} className="space-y-3 rounded-2xl border border-line bg-surface p-3">
     <h3 className="text-[17px] font-semibold">{block.question}</h3>
     {block.fields.map(f=><div key={f.key} className="grid gap-2 sm:grid-cols-2">
       <label className="text-[17px]">{f.label}<input type="text" inputMode="decimal" className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
         value={amounts[f.key]??""} disabled={disabled||busy} onChange={e=>setAmounts(p=>({...p,[f.key]:e.target.value}))}/></label>
       <label className="text-[17px]">{copy.clarifyOtherPlaceholder}<select className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
         value={selectedUnits[f.key]??f.defaultUnit} disabled={disabled||busy}
         onChange={e=>setSelectedUnits(p=>({...p,[f.key]:e.target.value}))}>
         {f.units.map(u=><option key={u} value={u}>{u}</option>)}</select></label>
     </div>)}
     <button type="button" disabled={disabled||busy} onClick={()=>void save()} className="min-h-12 rounded-xl bg-accent px-4 text-[17px] font-bold text-on-accent disabled:opacity-50">{copy.clarifySend}</button>
     {failure&&<p role="alert" className="text-[17px] text-neg">{copy.clarifyFillError}</p>}
   </section>;
 }
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
