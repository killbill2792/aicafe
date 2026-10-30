"use client";
import {useState} from "react";
import type {z} from "zod";
import {clarifyBlockSchema} from "@/lib/ai/conversations/contracts";
import {parseOwnerFactDecimal} from "@/lib/ownerFacts/numbers";
import {saveUsageEntry} from "@/lib/actions/pantry";
type Block=z.infer<typeof clarifyBlockSchema>;
type Copy={clarifyOther:string;clarifySend:string;clarifyYouChose:string;clarifySkipped:string;clarifyOtherPlaceholder:string;clarifyFillError:string;clarifyCountSummary:string;clarifyPurchaseSummary:string;
 pricingLaborPrefix:string;pricingBillsPrefix:string;clarifySaveError:string};
export function pricingOtherResponse(typed:string,options:readonly {value:string}[],
 copy:Pick<Copy,"pricingLaborPrefix"|"pricingBillsPrefix">):string{
 const kind=options.some(o=>o.value==="labor-monthly")?copy.pricingLaborPrefix:
  options.some(o=>o.value==="bills-monthly")?copy.pricingBillsPrefix:null;
 return kind?kind+": "+typed.trim():typed.trim();
}
export default function ClarifyCard({block,locale,copy,state,choice,disabled,onSend,onFacts}:{
 block:Block;locale:"en"|"es"|"ar";copy:Copy;state:"hidden"|"active"|"chosen"|"skipped";choice:string|null;
 disabled:boolean;onSend:(text:string)=>void;
 onFacts?:(questionId:string,answers:{fieldKey:string;value:string}[])=>Promise<void>;
}){
 const [other,setOther]=useState(false),[typed,setTyped]=useState("");
 const [amounts,setAmounts]=useState<Record<string,string>>({});
 const [selectedUnits,setSelectedUnits]=useState<Record<string,string>>({});
 const [busy,setBusy]=useState(false),[failure,setFailure]=useState<"invalid"|"save"|null>(null);
 const [factValues,setFactValues]=useState<Record<string,string>>({});
 const [factOtherText,setFactOtherText]=useState<Record<string,string>>({});
 if(state==="hidden")return null;
 if(state==="chosen")return <p dir={locale==="ar"?"rtl":"ltr"} className="text-[17px] text-ink-muted">{copy.clarifyYouChose.replace("{choice}",choice??"")}</p>;
 // A typed-answer card is answered in its own form, so a later message does not mean
 // it was skipped. Keep its question readable; it may be the whole reply.
 if(state==="skipped"&&(block.kind==="facts"||block.kind==="fill"))
   return <p dir={locale==="ar"?"rtl":"ltr"} className="text-[17px] text-ink-muted">{block.question}</p>;
 if(state==="skipped")return <p className="text-[17px] text-ink-muted">{copy.clarifySkipped}</p>;
 if(block.kind==="facts"){
   const save=async()=>{
     if(disabled||busy||!onFacts)return;
     const supplied=block.fields.filter(f=>(factValues[f.key]??"").trim().length>0);
     const answers=supplied.map(f=>({fieldKey:f.key,value:factValues[f.key]==="__other__"?
       "other"+((factOtherText[f.key]??"").trim()?":"+(factOtherText[f.key]??"").trim():""):
       factValues[f.key]??""}));
     const valid=supplied.length>0&&supplied.every((f,i)=>{
       const raw=answers[i].value;
       if(f.inputType==="number"||f.inputType==="money"||f.inputType==="percent"){
         const parsed=parseOwnerFactDecimal(raw,locale);
         return parsed!==null&&(f.inputType!=="percent"||parsed<=100);
       }
       if(f.inputType==="choice")return f.choices?.some(o=>o.value===raw)===true||
         raw==="other"||/^other:[\\s\\S]{1,200}$/.test(raw);
       if(f.inputType==="date")return /^\\d{4}-\\d{2}-\\d{2}$/.test(raw);
       return raw.trim().length>0;
     });
     if(!valid){setFailure("invalid");return;}
     setBusy(true);setFailure(null);
     try{await onFacts(block.questionId,answers);}
     catch{setFailure("save");}finally{setBusy(false);}
   };
   return <section dir={locale==="ar"?"rtl":"ltr"} className="space-y-3 rounded-2xl border border-line bg-surface p-3">
     <h3 className="text-[17px] font-semibold">{block.question}</h3>
     {block.fields.map(field=><div key={field.key} className="text-[17px]">
       {field.inputType==="choice"?<>
         <p className="font-semibold">{field.label}</p>
         <div className="mt-1 grid gap-2" role="group" aria-label={field.label}>
           {(field.choices??[]).map(o=><button key={o.value} type="button"
             disabled={disabled||busy} aria-pressed={factValues[field.key]===o.value}
             onClick={()=>setFactValues(old=>({...old,[field.key]:o.value}))}
             className="min-h-12 rounded-xl border border-line bg-surface2 px-3 text-start text-[17px] aria-pressed:border-accent aria-pressed:bg-accent-soft">
             {o.label}</button>)}
           <button type="button" disabled={disabled||busy}
             aria-pressed={factValues[field.key]==="__other__"}
             onClick={()=>setFactValues(old=>({...old,[field.key]:"__other__"}))}
             className="min-h-12 rounded-xl border border-line bg-surface2 px-3 text-start text-[17px] aria-pressed:border-accent aria-pressed:bg-accent-soft">
             {copy.clarifyOther}</button>
         </div>
         {factValues[field.key]==="__other__"&&<textarea rows={2} maxLength={200}
           aria-label={copy.clarifyOtherPlaceholder} placeholder={copy.clarifyOtherPlaceholder}
           className="mt-2 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
           value={factOtherText[field.key]??""} disabled={disabled||busy}
           onChange={e=>setFactOtherText(old=>({...old,[field.key]:e.target.value}))}/>}
       </>:<label className="block">{field.label}
         {field.inputType==="text"?<textarea rows={3} maxLength={1000} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
           value={factValues[field.key]??""} disabled={disabled||busy} aria-label={field.label}
           onChange={e=>setFactValues(old=>({...old,[field.key]:e.target.value}))}/>:
         <input type={field.inputType==="date"?"date":"text"}
           inputMode={field.inputType==="number"||field.inputType==="money"||field.inputType==="percent"?"decimal":undefined}
           className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"
           value={factValues[field.key]??""} disabled={disabled||busy} aria-label={field.label}
           onChange={e=>setFactValues(old=>({...old,[field.key]:e.target.value}))}/>}
       </label>}
     </div>)}
     <button type="button" disabled={disabled||busy||!onFacts} onClick={()=>void save()}
       className="min-h-12 rounded-xl bg-accent px-4 text-[17px] font-bold text-on-accent disabled:opacity-50">{copy.clarifySend}</button>
     {failure&&<p role="alert" className="text-[17px] text-neg">{failure==="save"?copy.clarifySaveError:copy.clarifyFillError}</p>}
   </section>;
 }
 if(block.kind==="fill"){
   const save=async()=>{
     if(disabled||busy)return;
     const values=block.fields.map(f=>({f,quantity:parseOwnerFactDecimal(amounts[f.key]??"",locale),
       unit:selectedUnits[f.key]??f.defaultUnit}));
     if(values.some(v=>v.quantity===null||v.quantity<0||v.f.key.startsWith("purchase:")&&v.quantity===0)){setFailure("invalid");return;}
     setBusy(true);setFailure(null);
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
       onSend(values.map(v=>{
         const amount=new Intl.NumberFormat(locale,{maximumFractionDigits:4}).format(v.quantity!);
         const match=v.f.key.match(/^(endCount|purchase):[0-9a-f-]{36}:(\d{4}-\d{2}-\d{2})$/i);
         const template=match?.[1]==="purchase"?copy.clarifyPurchaseSummary:copy.clarifyCountSummary;
         return template.replace("{item}",v.f.label).replace("{amount}",amount)
           .replace("{unit}",v.unit).replace("{date}",match?.[2]??"");
       }).join("; "));
     }catch{setFailure("save");}finally{setBusy(false);}
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
     {failure&&<p role="alert" className="text-[17px] text-neg">{failure==="save"?copy.clarifySaveError:copy.clarifyFillError}</p>}
   </section>;
 }
 return <section dir={locale==="ar"?"rtl":"ltr"} className="space-y-3 rounded-2xl border border-line bg-surface p-3">
   <h3 className="text-[17px] font-semibold text-ink">{block.question}</h3>
   <div className="space-y-2">{block.options.map((o,i)=><button key={o.value} type="button" disabled={disabled}
     onClick={()=>onSend(o.label)} className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-line bg-surface2 px-3 text-start text-[17px] font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
     <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm">{String.fromCharCode(65+i)}</span><span>{o.label}</span>
   </button>)}</div>
   {block.allowOther&&(other?<form className="space-y-2" onSubmit={e=>{e.preventDefault();if(typed.trim()&&!disabled){
     onSend(pricingOtherResponse(typed,block.options,copy));
   }}}>
     <input maxLength={200} value={typed} onChange={e=>setTyped(e.target.value)} aria-label={copy.clarifyOtherPlaceholder}
       placeholder={copy.clarifyOtherPlaceholder} className="min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-[17px] text-ink"/>
     <button type="submit" disabled={disabled||!typed.trim()} className="min-h-12 w-full rounded-xl bg-accent px-4 text-[17px] font-bold text-on-accent disabled:opacity-50">{copy.clarifySend}</button>
   </form>:<button type="button" disabled={disabled} onClick={()=>setOther(true)} className="min-h-12 w-full text-start text-[17px] font-semibold text-good focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">{copy.clarifyOther}</button>)}
 </section>;
}
