"use client";
import {useState,useTransition} from "react";
import {useRouter} from "@/i18n/navigation";
import type {ModifierSetup} from "@/lib/data/modifierLinks.server";
import {modifierLinkKey} from "@/lib/calc/modifierSuggestions";
import {confirmModifierLink} from "@/lib/actions/modifierLinks";

export default function InventoryModifierPanel({data,t,locale}:{
 data:ModifierSetup|null;t:Record<string,string>;locale:"en"|"es"|"ar"
}){
 const router=useRouter(),[pending,start]=useTransition();
 const [chosen,setChosen]=useState<Record<string,string>>({});
 const [failures,setFailures]=useState<Record<string,string>>({});
 if(!data)return <p role="alert" className="text-[17px]">{t.modifierUnavailable}</p>;
 const suggested=new Map(data.suggestions.map(s=>[modifierLinkKey(s),s]));
 return <details dir={locale==="ar"?"rtl":"ltr"}
   className="mb-5 rounded-2xl border border-line bg-surface p-4 text-ink">
   <summary className="min-h-12 cursor-pointer text-lg font-semibold">{t.modifierHeading}
    {" ("+data.observed.length+")"}
   </summary>
   <p className="my-3 text-[17px] text-muted">{t.modifierExplain}</p>
   {!data.observed.length&&<p className="text-[17px]">{t.modifierEmpty}</p>}
   <div className="space-y-3">
    {data.observed.map(item=>{
     const key=modifierLinkKey(item),hint=suggested.get(key);
     const selected=chosen[key]??"";
     return <div key={key} className="rounded-xl border border-line p-3">
      <p className="text-[17px] font-semibold">{item.name}</p>
      <p className="text-[17px] text-muted">{item.provider+" · "+item.locationRef}</p>
      {hint&&<p className="text-[17px]">{t.modifierSuggested+": "+hint.recipeName}</p>}
      <label className="block text-[17px]">{t.modifierRecipe}
       <select className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3 text-[17px]"
        value={selected} onChange={e=>setChosen(v=>({...v,[key]:e.target.value}))}>
        <option value="">{t.modifierChoose}</option>
        {data.recipes.map(recipe=><option key={recipe.id} value={recipe.id}>
         {recipe.name+" · "+recipe.quantityDelta+" "+(recipe.unit??"")}
        </option>)}
       </select>
      </label>
      <button type="button" disabled={pending||!selected}
       className="mt-2 min-h-12 rounded-xl bg-accent px-4 text-[17px] font-semibold text-on-accent disabled:opacity-50"
       onClick={()=>start(async()=>{
        try{
         const result=await confirmModifierLink({provider:item.provider,
          locationRef:item.locationRef,posModifierId:item.posModifierId,recipeId:selected});
         if(result.ok){setFailures(v=>({...v,[key]:""}));router.refresh();}
         else setFailures(v=>({...v,[key]:result.error??t.failed}));
        }catch{setFailures(v=>({...v,[key]:t.failed}));}
       })}>{t.modifierConfirm}</button>
      {failures[key]&&<p role="alert" className="text-[17px] text-neg">{failures[key]}</p>}
     </div>;
    })}
   </div>
 </details>;
}
