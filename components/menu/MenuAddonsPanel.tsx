"use client";
import {useState,useTransition} from "react";
import {useTranslations} from "next-intl";
import {useRouter} from "@/i18n/navigation";
import {Milk,Plus} from "lucide-react";
import {swapIngredient} from "@/lib/actions/pantry";
import {saveMenuProductAddons,type MenuAddon} from "@/lib/actions/menuAddons";
import {toBaseUnitQuantity} from "@/lib/calc/recipeUnits";
import type {IngredientUnitConversion,BaseUnit} from "@/lib/calc/recipeUnits";
import type {MenuItemForEdit} from "@/lib/data/getMenuItemsForEdit";
import {replacementDifferenceCents,additiveCostCents,keepFromAddon} from "@/lib/calc/menuAddons";
import {formatCents} from "@/lib/calc";
export type PricedPantry={id:string;name:string;category:string|null;baseUnit:BaseUnit;costPerBaseMicros:number|null};
export default function MenuAddonsPanel({itemId,items,pantry,saved,conversions}:{
 itemId:string;items:MenuItemForEdit[];pantry:PricedPantry[];saved:MenuAddon[];conversions:Record<string,IngredientUnitConversion[]>;
}){
 const t=useTranslations("MenuBuilder"),router=useRouter();const [pending,start]=useTransition(),[message,setMessage]=useState("");
 const [options,setOptions]=useState<MenuAddon[]>(saved),[changing,setChanging]=useState(false),[nextMilk,setNextMilk]=useState(""),[nextExtra,setNextExtra]=useState(""),[extraUpcharge,setExtraUpcharge]=useState("0.50");
 const first=items.find(i=>i.active)??items[0];
 const milkLine=first?.recipe.find(line=>pantry.some(i=>i.id===line.ingredientId&&i.category==="milk"));
 const milkRows=pantry.filter(item=>item.category==="milk");
 const defaultMilkId=options.find(option=>option.kind==="milk"&&option.isDefault)?.ingredientId??milkLine?.ingredientId??null;
 const current=pantry.find(item=>item.id===defaultMilkId);
 const currentLine=first?.recipe.find(line=>line.ingredientId===defaultMilkId)??milkLine;
 const selectedMilk=milkRows.filter(m=>m.id!==defaultMilkId);
 const extras=options.filter(option=>option.kind==="extra");
 function milkOption(id:string):MenuAddon{return options.find(o=>o.kind==="milk"&&o.ingredientId===id)??{ingredientId:id,kind:"milk",enabled:false,isDefault:false,upchargeCents:0,displayUnit:"ml",displayQuantity:1};}
 function update(option:MenuAddon){setOptions(old=>[...old.filter(o=>!(o.kind===option.kind&&o.ingredientId===option.ingredientId)),option]);}
 function priceToCents(value:string){const cents=Math.round(Number(value)*100);return Number.isSafeInteger(cents)&&cents>=0?cents:null;}
 function costOfMilk(id:string){if(!currentLine||!current)return null;const proposed=pantry.find(i=>i.id===id);if(!proposed)return null;return replacementDifferenceCents(currentLine.quantity,current.costPerBaseMicros,proposed.costPerBaseMicros);}
 function costOfExtra(opt:MenuAddon){const ingredient=pantry.find(i=>i.id===opt.ingredientId);if(!ingredient)return null;const base=toBaseUnitQuantity(opt.displayUnit,opt.displayQuantity,ingredient.baseUnit,conversions[ingredient.id]??[]);return base===null?null:additiveCostCents(base,ingredient.costPerBaseMicros);}
 function setDefault(){if(!milkLine){setMessage(t("addMilkFirst"));return;}if(!nextMilk)return;setMessage("");start(async()=>{const changed=await swapIngredient(itemId,milkLine.ingredientId,nextMilk);if(!changed.ok){setMessage(t("error"));return;}setOptions(old=>old.filter(o=>o.kind!=="milk"||(o.ingredientId!==nextMilk&&!o.isDefault)).concat({ingredientId:nextMilk,kind:"milk",enabled:true,isDefault:true,upchargeCents:0,displayUnit:"ml",displayQuantity:1}));setChanging(false);router.refresh();});}
 function save(){setMessage("");start(async()=>{const original=options.filter(o=>o.kind!=="milk"||o.ingredientId!==defaultMilkId);const defaultOption=defaultMilkId?{ingredientId:defaultMilkId,kind:"milk" as const,enabled:true,isDefault:true,upchargeCents:0,displayUnit:"ml" as const,displayQuantity:1}:null;const payload=defaultOption?[...original,defaultOption]:original;const out=await saveMenuProductAddons(itemId,payload);setMessage(out.ok?t("saved"):out.error);if(out.ok)router.refresh();});}
 function appendExtra(){const item=pantry.find(i=>i.id===nextExtra);const upcharge=priceToCents(extraUpcharge);if(!item||upcharge===null)return;const conversion=(conversions[item.id]??[])[0];const unit=conversion?.unit??item.baseUnit;update({ingredientId:item.id,kind:"extra",enabled:true,isDefault:false,upchargeCents:upcharge,displayUnit:unit,displayQuantity:1});setNextExtra("");}
 const tip=extras.find(o=>o.enabled);
 const tipCost=tip?costOfExtra(tip):null;
 const tipKeep=tip?keepFromAddon(tip.upchargeCents,tipCost):null;
 return <div className="mx-auto w-full max-w-2xl space-y-4 text-ink">
 <div className="flex items-center gap-3 rounded-[20px] border border-line bg-card p-4"><div className="flex size-12 items-center justify-center rounded-xl bg-accent-soft text-accent-text"><Milk/></div><div className="min-w-0 flex-1"><p className="text-sm text-ink-muted">{t("defaultMilk")}</p><p className="font-bold">{current?.name??t("unknown")}</p></div><button type="button" onClick={()=>{if(!milkLine){setMessage(t("addMilkFirst"));return;}setChanging(v=>!v);}} className="min-h-12 rounded-xl bg-accent-soft px-4 font-bold text-accent-text">{t("change")}</button></div>
 {changing&&<div className="flex flex-wrap gap-2 rounded-2xl border border-line bg-card p-3"><select aria-label={t("defaultMilk")} className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-card px-3" value={nextMilk} onChange={e=>setNextMilk(e.target.value)}><option value="">{t("defaultMilk")}</option>{milkRows.filter(i=>i.id!==milkLine?.ingredientId).map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select><button type="button" disabled={!nextMilk||pending} onClick={setDefault} className="min-h-12 rounded-xl bg-accent px-4 font-bold text-on-accent">{t("change")}</button></div>}
 <h2 className="font-headline text-lg font-extrabold">{t("milk")} · {t("customerUpcharge")}</h2>
 <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-card">{selectedMilk.map(ingredient=>{const option=milkOption(ingredient.id);const cost=costOfMilk(ingredient.id);return <div key={ingredient.id} className="flex min-h-20 flex-wrap items-center gap-2 p-3"><span className="flex size-10 items-center justify-center rounded-xl bg-paper">🥛</span><div className="min-w-0 flex-1"><p className="font-bold">{ingredient.name}</p><p className="text-[13px] text-ink-muted">{cost===null?t("estimate"):t("costsYou",{amount:formatCents(cost)})}</p></div><label className="flex min-w-24 items-center gap-1"><span className="text-[13px] text-ink-muted">$</span>{option.upchargeCents===0&&<span className="text-[13px] text-ink-muted">{t("noCharge")}</span>}<input type="number" min="0" step=".25" inputMode="decimal" aria-label={`${ingredient.name} ${t("customerUpcharge")}`} value={(option.upchargeCents/100).toFixed(2)} onChange={e=>{const cents=priceToCents(e.target.value);if(cents!==null)update({...option,upchargeCents:cents});}} className="min-h-12 w-20 rounded-lg border border-line bg-card px-2 text-end"/></label><label className="inline-flex min-h-12 items-center gap-1 font-semibold"><input type="checkbox" checked={option.enabled} onChange={e=>update({...option,enabled:e.target.checked})}/><span className="sr-only">{ingredient.name}</span></label></div>})}</div>
 <h2 className="font-headline text-lg font-extrabold">{t("extras")}</h2>
 <div className="flex flex-wrap gap-2">{extras.map(option=>{const ingredient=pantry.find(i=>i.id===option.ingredientId);return <button type="button" key={option.ingredientId} onClick={()=>update({...option,enabled:!option.enabled})} aria-pressed={option.enabled} className={`min-h-12 rounded-full border px-3 font-bold ${option.enabled?"border-accent bg-accent text-on-accent":"border-line bg-card"}`}>{option.enabled?"✓ ":""}{ingredient?.name??t("unknown")} · {option.upchargeCents?formatCents(option.upchargeCents):t("noCharge")}</button>})}</div>
 <div className="flex flex-wrap gap-2"><select aria-label={t("newExtra")} value={nextExtra} onChange={e=>setNextExtra(e.target.value)} className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-card px-2"><option value="">{t("newExtra")}</option>{pantry.filter(i=>i.category!=="milk"&&!options.some(o=>o.ingredientId===i.id)).map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select><label className="flex items-center gap-1 text-sm">$<input aria-label={t("customerUpcharge")} type="number" min="0" step=".25" value={extraUpcharge} onChange={e=>setExtraUpcharge(e.target.value)} className="min-h-12 w-20 rounded-xl border border-line bg-card px-2"/></label><button type="button" disabled={!nextExtra} onClick={appendExtra} className="min-h-12 rounded-xl border border-dashed border-accent px-3 font-bold text-accent-text"><Plus className="inline size-4"/>{t("newExtra")}</button></div>
 {tip&&<div className="rounded-2xl border border-line bg-card p-4">💡 {tipKeep===null?t("estimatedCost"):t("tipExtra",{amount:formatCents(tipKeep)})}</div>}
 {message&&<p role="status" className="text-ink-muted">{message}</p>}
 <button type="button" disabled={pending} onClick={save} className="min-h-14 w-full rounded-2xl bg-accent text-lg font-bold text-on-accent disabled:opacity-50">{t("save")} {t("addons")}</button>
 </div>;
}
