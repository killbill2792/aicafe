"use client";

import {useState,useTransition} from "react";
import {useTranslations} from "next-intl";
import {useRouter} from "@/i18n/navigation";
import {createPantryIngredient,savePackPrice} from "@/lib/actions/pantry";
import {parsePurchasePack} from "./purchasePackEntry";
import type {BaseUnit} from "@/lib/calc/recipeUnits";

type Created={id:string;baseUnit:BaseUnit;name:string};
export default function NewPantryInlineRow({onCancel,onCreated}:{onCancel:()=>void;onCreated?:(result:Created)=>Promise<void>|void}){
 const t=useTranslations("MenuBuilder"),router=useRouter(),[pending,start]=useTransition();
 const [name,setName]=useState(""),[pack,setPack]=useState(""),[price,setPrice]=useState("");
 const [measure,setMeasure]=useState<BaseUnit|null>(null),[error,setError]=useState("");
 const [partial,setPartial]=useState(false);
 const matches=(["ml","g","each"] as const).flatMap(baseUnit=>{
  const parsed=parsePurchasePack(pack,baseUnit);return parsed?[{baseUnit,...parsed}]:[];
 });
 // The purchase label normally determines the physical unit. If it says just
 // "ounces", never silently choose a liquid rather than a weight.
 const needsMeasurement=matches.length!==1;
 const selected=measure?matches.find(x=>x.baseUnit===measure):matches.length===1?matches[0]:null;
 function submit(){
  if(pending||!name.trim()||name.trim().length>60)return;
  if((pack.trim()||price.trim())&&(!selected||!(Number(price)>0)||!/^\d+(?:\.\d{1,2})?$/.test(price.trim()))){setError(t("invalidPurchasePack"));return;}
  if(!selected&&!measure){setError(t("chooseMeasurement"));return;}
  const baseUnit=selected?.baseUnit??measure!;
  setError("");start(async()=>{
   // No duplicate writer: compose the existing tenant-scoped create and pack-price actions.
   const result=await createPantryIngredient({name:name.trim(),category:"other",baseUnit});
   if(!result.ok||!result.id){setError(t("error"));return;}
   if(selected){
    const cents=Math.round(Number(price)*100);
    const priceResult=await savePackPrice({ingredientId:result.id,packQuantity:selected.packQuantity,packUnit:selected.packUnit,packCostCents:cents});
    if(!priceResult.ok){setPartial(true);setError(t("createdWithoutPrice"));router.refresh();return;}
   }
   if(onCreated)await onCreated({id:result.id,baseUnit,name:name.trim()});
   else router.refresh();
   onCancel();
  });
 }
 return <div className="rounded-xl border-2 border-accent/50 bg-card p-3" role="group" aria-label={t("newIngredient")}>
  <div className="grid gap-2 md:grid-cols-[1fr_1fr_140px]">
   <label className="min-w-0 font-semibold">{t("name")}
    <input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder={t("newIngredient")}
     className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px]"/>
   </label>
   <label className="min-w-0 font-semibold">{t("packSize")}
    <input value={pack} onChange={e=>{setPack(e.target.value);setMeasure(null);}}
     placeholder={t("purchasePackExampleLiquid")}
     className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px]"/>
   </label>
   <label className="min-w-0 font-semibold">{t("packPrice")}
    <input inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)}
     placeholder={t("packPrice")} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px]"/>
   </label>
  </div>
  {needsMeasurement&&<label className="mt-2 block font-semibold">{t("measurementType")}
   <select value={measure??""} onChange={e=>setMeasure(e.target.value as BaseUnit)} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3">
    <option value="">{t("measurementType")}</option>{(matches.length?matches:[{baseUnit:"ml" as const},{baseUnit:"g" as const},{baseUnit:"each" as const}]).map(x=><option key={x.baseUnit} value={x.baseUnit}>{x.baseUnit==="ml"?t("liquidMeasurement"):x.baseUnit==="g"?t("weightMeasurement"):t("pieceMeasurement")}</option>)}
   </select>
  </label>}
  {!pack.trim()&&!price.trim()&&<p className="mt-2 text-[15px] text-ink-muted">{t("priceCanComeLater")}</p>}
  {partial&&<p role="status" className="mt-2 text-[17px] text-warn">{t("createdWithoutPrice")}</p>}
  {error&&<p role="alert" className="mt-2 text-[17px] text-warn">{error}</p>}
  <div className="mt-3 flex flex-wrap gap-2">
   <button type="button" disabled={pending||!name.trim()||partial} onClick={submit} className="min-h-12 rounded-xl bg-accent px-5 font-bold text-on-accent disabled:opacity-40">{t("create")}</button>
   <button type="button" onClick={onCancel} className="min-h-12 rounded-xl border border-line px-4">{t("cancel")}</button>
  </div>
 </div>;
}
