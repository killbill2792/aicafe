"use client";
import { useState,useTransition } from "react";
import { useTranslations } from "next-intl";
import { Coffee,Utensils,ShoppingBag,Package,Check } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { addMenuItem,saveMenuItemAggregateCost } from "@/lib/actions/menuItems";
import { applyTemplate } from "@/lib/actions/pantry";
import type { RecipeTemplateKey } from "@/lib/menu/recipeTemplates";
import { RECIPE_TEMPLATES } from "@/lib/menu/recipeTemplates";
import { isAmbiguousNumericSizeLabel } from "@/lib/menu/sizeLabel";
import SizeLabelClarifyDialog from "./SizeLabelClarifyDialog";
type Kind="drink"|"food"|"retail"|"combo";type Mode="template"|"quick"|"blank";
const templates:{key:RecipeTemplateKey|null;name:string;description:string}[]=[
 {key:"latte",name:"Latte",description:"Espresso + milk"},{key:"cappuccino",name:"Cappuccino",description:"Foamy espresso"},{key:"americano",name:"Americano",description:"Espresso + water"},{key:"mocha",name:"Mocha",description:"Chocolate latte"},{key:"iced-latte",name:"Iced latte",description:"Cold espresso + milk"},{key:"cold-brew",name:"Cold brew",description:"Slow brewed coffee"},{key:"chai-latte",name:"Chai",description:"Spiced tea + milk"},{key:"matcha-latte",name:"Matcha",description:"Green tea latte"},{key:null,name:"Pastry",description:"Fresh bakery item"}];
export default function NewMenuItemForm({menuGroupOptions}:{menuGroupOptions:string[]}) {
 const t=useTranslations("MenuBuilder"),common=useTranslations("Common"),router=useRouter();
 const [kind,setKind]=useState<Kind>("drink"),[mode,setMode]=useState<Mode>("template"),[template,setTemplate]=useState<(typeof templates)[number]>(templates[0]);
 const [editing,setEditing]=useState(false),[name,setName]=useState(""),[size,setSize]=useState("12 oz"),[price,setPrice]=useState(""),[cost,setCost]=useState(""),[group,setGroup]=useState("");
 const [pending,start]=useTransition(),[error,setError]=useState(""),[clarify,setClarify]=useState(false);
 function selectMode(next:Mode){setMode(next);setEditing(true);if(next==="template"){setName(template.name);setSize(template.key==="iced-latte"||template.key==="cold-brew"?"16 oz":"12 oz");}else{setName("");setSize(kind==="drink"?"12 oz":"");}setError("");}
 function createClick(){if(!name.trim()||!(Math.round(Number(price)*100)>0))return;if(isAmbiguousNumericSizeLabel(size)){setClarify(true);return;}void submit(size);}
 async function submit(resolvedSize:string){
   setError("");start(async()=>{
   const result=await addMenuItem({name:name.trim(),sizeLabel:resolvedSize.trim()||undefined,priceCents:Math.round(Number(price)*100),menuGroup:group.trim()||undefined,category:kind==="food"?"FOOD":kind==="retail"?"RETAIL":undefined});
   if(!result.ok){setError(result.error);return;}
   if(mode==="quick"){const cents=Math.round(Number(cost)*100);if(cents>0){const saved=await saveMenuItemAggregateCost({menuItemId:result.id,costCents:cents,estimated:true});if(!saved.ok){setError(t("error"));return;}}}
   if(mode==="template"&&template.key){const applied=await applyTemplate(result.id,template.key);if(!applied.ok){setError(applied.missingPantry?.length?t("templateMissing"):t("error"));router.push(`/menu/${result.id}?setupRecipe=1`);return;}}
   router.push(`/menu/${result.id}?setupRecipe=1`);
 });}
 return <div className="mx-auto w-full max-w-3xl text-ink">
 {!editing?<><h2 className="mb-3 font-headline text-xl font-extrabold">{t("type")}</h2>
 <div className="grid grid-cols-4 gap-2">{(["drink","food","retail","combo"] as const).map((type,i)=>{const Icon=[Coffee,Utensils,ShoppingBag,Package][i];return <button type="button" key={type} aria-pressed={kind===type} onClick={()=>setKind(type)} className={`flex min-h-24 flex-col items-center justify-center gap-2 rounded-2xl border p-2 text-[14px] font-bold ${kind===type?"border-accent bg-accent-soft text-accent-text":"border-line bg-card"}`}><Icon className="size-6"/>{t(type)}</button>})}</div>
 {kind==="drink"&&<><h2 className="mb-3 mt-6 font-headline text-xl font-extrabold">{t("startTemplate")}</h2><div className="grid grid-cols-3 gap-2">{templates.map(item=><button type="button" key={item.name} onClick={()=>setTemplate(item)} aria-pressed={template.name===item.name} className={`min-h-28 rounded-2xl border p-3 text-start ${template.name===item.name?"border-accent bg-accent-soft":"border-line bg-card"}`}><span className="mb-2 block text-xl">{item.key==="matcha-latte"?"🍵":item.key===null?"🥐":"☕"}</span><span className="block text-[15px] font-bold">{item.name}</span><span className="block text-[13px] text-ink-muted">{item.description}</span></button>)}</div><button type="button" onClick={()=>selectMode(template.key?"template":"blank")} className="mt-4 min-h-14 w-full rounded-2xl bg-accent font-bold text-on-accent">{t("continueWith",{name:template.name})}</button></>}
 <button type="button" onClick={()=>selectMode("quick")} className="mt-3 min-h-14 w-full rounded-2xl border border-accent bg-card px-3 font-bold text-accent-text">{t("quickEstimate")}</button>
 <button type="button" onClick={()=>selectMode("blank")} className="mt-3 min-h-12 w-full font-bold text-accent-text underline">{t("startBlank")}</button>
 </>:<section className="rounded-[20px] border border-line bg-card p-4 sm:p-6">
 <h2 className="font-headline text-2xl font-extrabold">{mode==="quick"?t("quickMode"):mode==="blank"?t("startBlank"):t("continueWith",{name:template.name})}</h2><p className="mt-2 text-[15px] text-ink-muted">{mode==="quick"?t("quickHelp"):mode==="template"?t("templateNote"):t("switchFull")}</p>
 <div className="mt-5 grid gap-4">
 <label className="font-semibold">{t("nameItem")}<input value={name} onChange={e=>setName(e.target.value)} autoFocus className="mt-1 block min-h-12 w-full rounded-xl border border-line bg-card px-3"/></label>
 <label className="font-semibold">{t("itemSize")}<input value={size} onChange={e=>setSize(e.target.value)} className="mt-1 block min-h-12 w-full rounded-xl border border-line bg-card px-3"/></label>
 <label className="font-semibold">{t("itemPrice")}<input type="number" inputMode="decimal" min="0.01" step="0.01" value={price} onChange={e=>setPrice(e.target.value)} className="mt-1 block min-h-12 w-full rounded-xl border border-line bg-card px-3"/></label>
 {mode==="quick"&&<label className="font-semibold">{t("itemCost")}<input type="number" inputMode="decimal" min="0.01" step="0.01" value={cost} onChange={e=>setCost(e.target.value)} className="mt-1 block min-h-12 w-full rounded-xl border border-line bg-card px-3" required/></label>}
 <label className="font-semibold">{common("next")}<input list="menu-group-options" value={group} onChange={e=>setGroup(e.target.value)} className="mt-1 block min-h-12 w-full rounded-xl border border-line bg-card px-3"/></label><datalist id="menu-group-options">{menuGroupOptions.map(g=><option key={g} value={g}/>)}</datalist>
 </div>{error&&<p role="alert" className="my-3 text-warn">{error}</p>}<div className="mt-5 flex gap-2"><button type="button" onClick={()=>setEditing(false)} className="min-h-12 flex-1 rounded-xl border border-line font-bold">{common("back")}</button><button type="button" disabled={pending||!name.trim()||!(Number(price)>0)||(mode==="quick"&&!(Number(cost)>0))} onClick={createClick} className="min-h-14 flex-1 rounded-xl bg-accent font-bold text-on-accent disabled:opacity-50">{t("createItem")}</button></div>
 </section>}
 {clarify&&<SizeLabelClarifyDialog value={size} onResolve={v=>{setClarify(false);setSize(v);void submit(v);}} onCancel={()=>setClarify(false)}/>}
 </div>;
}
