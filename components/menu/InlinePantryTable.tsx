"use client";

import {useState,useTransition} from "react";
import {useLocale} from "next-intl";
import {useRouter} from "@/i18n/navigation";
import {savePackPrice,updatePantryIngredient} from "@/lib/actions/pantry";
import {packBaseQuantity,type BaseUnit} from "@/lib/calc/recipeUnits";
import {formatCents} from "@/lib/calc";
import {parsePurchasePack,purchasePackLabel} from "./purchasePackEntry";

type PantryItem={
 id:string;name:string;category:string|null;baseUnit:BaseUnit;
 packQuantity:number|null;packUnit:string|null;packCostCents:number|null;
 costPerBaseMicros:number|null;
};
function PantryTableRow({item,t}:{item:PantryItem;t:Record<string,string>}){
 const router=useRouter(),locale=useLocale(),[pending,start]=useTransition();
 const initialPack=purchasePackLabel(item.packQuantity,item.packUnit,item.baseUnit,locale);
 const [name,setName]=useState(item.name);
 const [pack,setPack]=useState(initialPack);
 const [price,setPrice]=useState(item.packCostCents===null?"":(item.packCostCents/100).toFixed(2));
 const [error,setError]=useState(""),[saved,setSaved]=useState(false);
 const nameChanged=name.trim()!==item.name;
 const priceChanged=price!== (item.packCostCents===null?"":(item.packCostCents/100).toFixed(2))||pack.trim()!==initialPack;
 function save(){
  setError("");setSaved(false);
  if(!name.trim()||(!nameChanged&&!priceChanged))return;
  const parsed=priceChanged?parsePurchasePack(pack,item.baseUnit):null;
  const cents=priceChanged?Math.round(Number(price)*100):null;
  if(priceChanged&&(!parsed||price.trim()===""||cents===null||!Number.isSafeInteger(cents)||cents<=0
     ||packBaseQuantity(parsed.packQuantity,parsed.packUnit,item.baseUnit)===null)){setError(t.error);return;}
  start(async()=>{
   // Existing scoped actions are authoritative. An error never claims the entire row saved.
   if(nameChanged){
    const nameResult=await updatePantryIngredient({id:item.id,name:name.trim(),category:
      (["coffee","milk","syrup","sauce","powder","tea","packaging","bakery","food","other"].includes(item.category??"")
      ?item.category:"other") as "coffee"|"milk"|"syrup"|"sauce"|"powder"|"tea"|"packaging"|"bakery"|"food"|"other"});
    if(!nameResult.ok){setError(t.error);return;}
   }
   if(priceChanged&&parsed&&cents!==null){
    const priceResult=await savePackPrice({ingredientId:item.id,packQuantity:parsed.packQuantity,
      packUnit:parsed.packUnit,packCostCents:cents});
    if(!priceResult.ok){setError(t.error);router.refresh();return;}
   }
   setSaved(true);router.refresh();
  });
 }
 return <div className="grid gap-2 border-b border-line px-3 py-3 last:border-b-0 md:grid-cols-[minmax(160px,1.3fr)_minmax(160px,1fr)_minmax(120px,.7fr)_auto] md:items-end">
  <label className="min-w-0 text-[13px] font-semibold text-ink-muted md:font-normal">
   <span className="md:sr-only">{t.name}</span>
   <input value={name} onChange={e=>{setName(e.target.value);setSaved(false);}}
    aria-label={t.name+": "+item.name}
    className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px] font-semibold text-ink md:mt-0"/>
  </label>
  <label className="min-w-0 text-[13px] font-semibold text-ink-muted">
   <span className="md:sr-only">{t.packSize}</span>
   <input value={pack} onChange={e=>{setPack(e.target.value);setSaved(false);}}
    placeholder={item.baseUnit==="ml"?t.purchasePackExampleLiquid:item.baseUnit==="g"?t.purchasePackExampleWeight:t.purchasePackExampleCount}
    aria-label={t.packSize+": "+item.name}
    className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px] text-ink md:mt-0"/>
  </label>
  <label className="min-w-0 text-[13px] font-semibold text-ink-muted">
   <span className="md:sr-only">{t.packPrice}</span>
   <input inputMode="decimal" value={price} onChange={e=>{setPrice(e.target.value);setSaved(false);}}
    placeholder={t.packPrice} aria-label={t.packPrice+": "+item.name}
    className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px] text-ink md:mt-0"/>
  </label>
  <div className="flex min-h-12 items-center justify-between gap-2 md:justify-end">
   <span className="text-[13px] text-ink-muted md:sr-only">{item.packCostCents===null?t.priceUnknown:formatCents(item.packCostCents)}</span>
   <button type="button" onClick={save} disabled={pending||(!nameChanged&&!priceChanged)}
    className="min-h-12 min-w-20 rounded-xl bg-accent px-3 font-bold text-on-accent disabled:opacity-40">{t.save}</button>
  </div>
  {error&&<p role="alert" className="text-[17px] text-warn md:col-span-4">{t.error}</p>}
  {saved&&<p role="status" className="text-[15px] text-good md:col-span-4">{t.save} ✓</p>}
 </div>;
}

export default function InlinePantryTable({items,t}:{items:PantryItem[];t:Record<string,string>}){
 return <section className="overflow-hidden rounded-2xl border border-line bg-card">
  <div className="hidden grid-cols-[minmax(160px,1.3fr)_minmax(160px,1fr)_minmax(120px,.7fr)_auto] gap-2 border-b border-line bg-paper px-3 py-3 text-[15px] font-bold text-ink md:grid">
   <span>{t.name}</span><span>{t.packSize}</span><span>{t.packPrice}</span><span>{t.edit}</span>
  </div>
  {items.map(item=><PantryTableRow key={[item.id,item.name,item.packQuantity,item.packUnit,item.packCostCents].join(":")} item={item} t={t}/>)}
  {!items.length&&<p className="p-5 text-ink-muted">{t.noItems}</p>}
 </section>;
}
