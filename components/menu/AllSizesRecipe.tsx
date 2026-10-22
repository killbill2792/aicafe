"use client";
import {useState,useTransition} from "react";
import {useLocale,useTranslations} from "next-intl";
import {Plus,Minus,X,ArrowLeftRight,ChevronDown} from "lucide-react";
import {useRouter} from "@/i18n/navigation";
import {saveProductRecipes} from "@/lib/actions/pantry";
import {updateMenuItemPrice} from "@/lib/actions/menuItems";
import type {UnpricedMenuSize} from "@/lib/data/getUnpricedProductSizes";
import {swapIngredient} from "@/lib/actions/pantry";
import {stepFor} from "@/lib/calc/recipeUnits";
import type {RecipeDisplayUnit,IngredientUnitConversion} from "@/lib/calc/recipeUnits";
import type {IngredientOption,MenuItemForEdit} from "@/lib/data/getMenuItemsForEdit";
import {recipePreviewCost,keepPreview,draftLineCostCents} from "@/lib/calc/recipePreview";
import {formatCents} from "@/lib/calc";
import AddSizeDialog from "./AddSizeDialog";
import type {PricedPantry} from "./MenuAddonsPanel";
import {toBaseUnitQuantity} from "@/lib/calc/recipeUnits";
import {swapPortionDifferenceCents,additiveCostCents} from "@/lib/calc/menuAddons";
type Draft={unit:RecipeDisplayUnit;quantity:number;removed:boolean};
function k(item:string,ingredient:string){return item+":"+ingredient;}
export default function AllSizesRecipe({items,ingredients,conversions,pantry,draftSizes}:{items:MenuItemForEdit[];ingredients:IngredientOption[];conversions:Record<string,IngredientUnitConversion[]>;pantry:PricedPantry[];draftSizes:UnpricedMenuSize[]}){
 const t=useTranslations("MenuBuilder"),units=useTranslations("ManageMenu"),locale=useLocale(),router=useRouter();const [pending,start]=useTransition(),[error,setError]=useState(""),[saved,setSaved]=useState(false);
 const [active,setActive]=useState<string[]>(items.filter(i=>i.active).map(i=>i.id));const [math,setMath]=useState(false);
 const [drafts,setDrafts]=useState<Record<string,Draft>>(()=>Object.fromEntries(items.flatMap(item=>item.recipe.map(line=>[k(item.id,line.ingredientId),{quantity:line.displayQuantity??line.quantity,unit:(line.displayUnit??line.baseUnit) as RecipeDisplayUnit,removed:false}]))));
 const [priceDraft,setPriceDraft]=useState<string|null>(null),[draftPrice,setDraftPrice]=useState("");
 const [sizeDialog,setSizeDialog]=useState(false);const [add,setAdd]=useState<string|null>(null),[swap,setSwap]=useState<string|null>(null),[choice,setChoice]=useState(""),[toast,setToast]=useState("");
 const selectedItems=items.filter(i=>active.includes(i.id)), ingredientRows=[...new Map(items.flatMap(item=>item.recipe.map(line=>[line.ingredientId,line.ingredientName] as const))).entries()];
 const prices=Object.fromEntries(selectedItems.map(item=>{const amount=Object.fromEntries(item.recipe.map(line=>[line.ingredientId,drafts[k(item.id,line.ingredientId)]?.removed?0:drafts[k(item.id,line.ingredientId)]?.quantity??line.displayQuantity??line.quantity]));const lines=item.recipe.filter(line=>!drafts[k(item.id,line.ingredientId)]?.removed);const preview=recipePreviewCost(lines,amount);const cost=preview.costCents??(item.recipe.length===0?item.ownerTotalCostCents??null:null);return[item.id,{cost,summary:keepPreview(item.priceCents,cost),estimated:preview.estimated||item.costSource==="owner_total"||item.ownerTotalCostStatus==="estimated"}]}));
 function adjust(item:MenuItemForEdit,id:string,delta:number){const line=item.recipe.find(l=>l.ingredientId===id);if(!line)return;const key=k(item.id,id);const cur=drafts[key]??{quantity:line.displayQuantity??line.quantity,unit:(line.displayUnit??line.baseUnit) as RecipeDisplayUnit,removed:false};const step=stepFor(cur.unit);setDrafts(prev=>({...prev,[key]:{...cur,removed:false,quantity:Math.max(0,Math.round((cur.quantity+delta*step)*100)/100)}}));setSaved(false);}
 function removeRow(id:string){setDrafts(prev=>({...prev,...Object.fromEntries(items.filter(item=>item.recipe.some(l=>l.ingredientId===id)).map(item=>{const key=k(item.id,id);const line=item.recipe.find(l=>l.ingredientId===id)!;return[key,{...(prev[key]??{unit:(line.displayUnit??line.baseUnit) as RecipeDisplayUnit,quantity:line.displayQuantity??line.quantity}),removed:true}]}))}));setToast(ingredientRows.find(row=>row[0]===id)?.[1]??"");}
 function undo(){const id=ingredientRows.find(row=>row[1]===toast)?.[0];if(!id)return;setDrafts(prev=>({...prev,...Object.fromEntries(items.filter(i=>i.recipe.some(l=>l.ingredientId===id)).map(item=>[k(item.id,id),{...prev[k(item.id,id)],removed:false}]))}));setToast("");}
 function recipeChanges(newIngredientId?:string){
  return items.map(item=>({
   itemId:item.id,
   expected:item.recipe.map(line=>({ingredientId:line.ingredientId,quantity:line.quantity,displayUnit:line.displayUnit,displayQuantity:line.displayQuantity})),
   lines:[
    ...item.recipe.flatMap(line=>{
      const d=drafts[k(item.id,line.ingredientId)];
      if(d?.removed||d?.quantity===0)return [];
      return [{ingredientId:line.ingredientId,displayUnit:(d?.unit??line.displayUnit??line.baseUnit) as RecipeDisplayUnit,displayQuantity:d?.quantity??line.displayQuantity??line.quantity}];
    }),
    ...(newIngredientId&&active.includes(item.id)?(()=>{
      const ingredient=ingredients.find(i=>i.id===newIngredientId);
      return ingredient?[{ingredientId:ingredient.id,displayUnit:ingredient.baseUnit,displayQuantity:1}]:[];
    })():[])
   ],
  }));
 }
 function save(){if(!items[0])return;setError("");start(async()=>{
  const result=await saveProductRecipes({productId:items[0].id,sizes:recipeChanges()});
  if(!result.ok){setError(t("error"));return;}
  setSaved(true);setToast("");router.refresh();
 });}
 function append(){if(!add||!items[0]||selectedItems.length===0)return;
  setError("");start(async()=>{
   const result=await saveProductRecipes({productId:items[0].id,sizes:recipeChanges(add)});
   if(!result.ok){setError(t("error"));return;}
   setAdd(null);router.refresh();
  });
 }
 function saveDraftSizePrice(){if(!priceDraft)return;const cents=Math.round(Number(draftPrice)*100);if(!Number.isSafeInteger(cents)||cents<=0)return;start(async()=>{const result=await updateMenuItemPrice({menuItemId:priceDraft,priceCents:cents});if(!result.ok)setError(result.error);else{setPriceDraft(null);router.refresh();}});}
 function performSwap(){if(!swap||!choice)return;start(async()=>{const result=await swapIngredient(items[0].id,swap,choice);if(!result.ok)setError(t("error"));else{setSwap(null);router.refresh();}});}
 const source=pantry.find(p=>p.id===swap);
 const representative=selectedItems.find(item=>item.recipe.some(line=>line.ingredientId===swap));
 const selectedLine=representative?.recipe.find(line=>line.ingredientId===swap);
 const swapChoices=source?pantry.filter(p=>p.baseUnit===source.baseUnit):[];
 function swapPrice(candidate:PricedPantry):number|null{
  if(!source||!selectedLine||!representative)return null;
  const displayUnit=(selectedLine.displayUnit??selectedLine.baseUnit) as RecipeDisplayUnit;
  const translated=toBaseUnitQuantity(displayUnit,selectedLine.displayQuantity??selectedLine.quantity,candidate.baseUnit,conversions[candidate.id]??[]);
  const oldAmount=toBaseUnitQuantity(displayUnit,selectedLine.displayQuantity??selectedLine.quantity,source.baseUnit,conversions[source.id]??[]);
  if(translated===null||oldAmount===null||source.costPerBaseMicros===null||candidate.costPerBaseMicros===null)return null;
  return swapPortionDifferenceCents(oldAmount,source.costPerBaseMicros,translated,candidate.costPerBaseMicros);
 }
 function swapDrinkCost(candidate:PricedPantry):number|null{
  if(!selectedLine)return null;
  const unit=(selectedLine.displayUnit??selectedLine.baseUnit) as RecipeDisplayUnit;
  const base=toBaseUnitQuantity(unit,selectedLine.displayQuantity??selectedLine.quantity,candidate.baseUnit,conversions[candidate.id]??[]);
  return base===null?null:additiveCostCents(base,candidate.costPerBaseMicros);
 }
 function cells(id:string){return <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:flex lg:justify-around">{selectedItems.map(item=>{const line=item.recipe.find(l=>l.ingredientId===id);const d=drafts[k(item.id,id)];if(!line||d?.removed)return <p key={item.id} className="p-2 text-center text-ink-muted">—</p>;const actual=d??{quantity:line.displayQuantity??line.quantity,unit:(line.displayUnit??line.baseUnit) as RecipeDisplayUnit};const cost=draftLineCostCents(line.costCents,line.displayQuantity??line.quantity,actual.quantity);return <div key={item.id} className="min-w-0 lg:flex-1"><div className="flex min-h-12 min-w-0 items-center justify-between gap-0.5 rounded-xl bg-paper px-0.5"><button type="button" onClick={()=>adjust(item,id,-1)} aria-label={`− ${line.ingredientName} ${item.sizeLabel}`} className="flex size-12 shrink-0 items-center justify-center rounded-lg text-accent-text"><Minus size={17}/></button><span className="min-w-0 break-words text-center text-[13px] font-bold">{new Intl.NumberFormat(locale,{maximumFractionDigits:2}).format(actual.quantity)} {({shot:units("recipeUnitShot"),pump:units("recipeUnitPump"),g:units("recipeUnitG"),ml:units("recipeUnitMl"),fl_oz:units("recipeUnitFlOz"),each:units("recipeUnitEach")} as Record<RecipeDisplayUnit,string>)[actual.unit]}</span><button type="button" onClick={()=>adjust(item,id,1)} aria-label={`+ ${line.ingredientName} ${item.sizeLabel}`} className="flex size-10 shrink-0 items-center justify-center rounded-lg text-accent-text"><Plus size={17}/></button></div><p className="mt-1 text-center text-[13px] text-ink-muted">{cost===null?"—":formatCents(cost)}</p>{math&&<p className="text-center text-[13px] text-ink-muted">{line.quantity.toFixed(2)} {line.baseUnit}</p>}</div>})}</div>}
 return <div className="relative pb-48 text-ink lg:pe-[310px] lg:pb-8"><p className="mb-2 font-semibold text-ink-muted">{t("sizesSell")}</p><div className="mb-3 flex flex-wrap gap-2">{items.map(item=><button key={item.id} type="button" aria-pressed={active.includes(item.id)} onClick={()=>setActive(prev=>prev.includes(item.id)?prev.filter(x=>x!==item.id):[...prev,item.id])} className={`min-h-12 rounded-full border px-3 font-bold ${active.includes(item.id)?"border-accent bg-accent text-on-accent":"border-line bg-card"}`}>{active.includes(item.id)?"✓ ":""}{item.sizeLabel??item.name}</button>)} {draftSizes.map(draft=><button type="button" key={draft.id} onClick={()=>{setPriceDraft(draft.id);setDraftPrice("");}} className="min-h-12 rounded-full border border-dashed border-warn px-3 text-warn">{draft.sizeLabel??draft.name} · {t("priceNotSet")}</button>)}<button type="button" onClick={()=>setSizeDialog(true)} className="min-h-12 rounded-full border border-dashed border-accent px-3 text-accent-text">{t("addSize")}</button></div>
 <div className="mb-3 rounded-2xl bg-pos-soft p-3 text-[15px] text-good">✨ {t("industryNote")}</div>
 <div className="mb-2 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:hidden">{selectedItems.map(item=><div key={item.id} className="rounded-xl bg-paper p-2 text-center font-bold">{item.sizeLabel??item.name}</div>)}</div>
 <div className="space-y-2 lg:hidden">{ingredientRows.map(([id,name])=><div key={id} className="rounded-2xl border border-line bg-card p-3"><div className="mb-2 flex min-h-10 items-center gap-2"><span className="text-xl">🥛</span><strong className="min-w-0 flex-1 break-words">{name}</strong><button type="button" onClick={()=>{setSwap(id);setChoice(id)}} className="min-h-10 rounded-xl bg-accent-soft px-2 text-[13px] font-bold text-accent-text"><ArrowLeftRight size={15} className="me-1 inline"/>{t("swap")}</button><button type="button" aria-label={t("remove")} onClick={()=>removeRow(id)} className="flex size-10 items-center justify-center rounded-full bg-paper"><X size={17}/></button></div>{cells(id)}</div>)}</div>
 <div className="hidden overflow-x-auto rounded-2xl border border-line bg-card lg:block"><table className="w-full table-fixed"><thead><tr className="border-b border-line bg-paper"><th className="w-[28%] p-3 text-start">{t("name")}</th>{selectedItems.map(item=><th key={item.id} className="p-3">{item.sizeLabel??item.name}</th>)}</tr></thead><tbody>{ingredientRows.map(([id,name])=><tr key={id} className="border-b border-line"><th className="p-3 text-start"><span>{name}</span><div><button type="button" className="min-h-10 text-sm text-accent-text" onClick={()=>{setSwap(id);setChoice(id)}}>{t("swap")}</button><button type="button" className="ms-2 min-h-10 text-sm text-warn" onClick={()=>removeRow(id)}>{t("remove")}</button></div></th><td className="p-2" colSpan={selectedItems.length}>{cells(id)}</td></tr>)}</tbody></table></div>
 {add!==null?<div className="mt-3 flex flex-wrap gap-2 rounded-2xl border border-line bg-card p-3"><select className="min-h-12 min-w-0 flex-1 bg-card" aria-label={t("addToRecipe")} value={add} onChange={e=>setAdd(e.target.value)}><option value="">{t("addToRecipe")}</option>{ingredients.filter(i=>!ingredientRows.some(x=>x[0]===i.id)).map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select><button disabled={pending||!add} onClick={append} className="min-h-12 rounded-xl bg-accent px-4 font-bold text-on-accent">{t("add")}</button><button onClick={()=>setAdd(null)} className="min-h-12 px-3">{t("cancel")}</button></div>:<button type="button" onClick={()=>setAdd("")} className="mt-3 min-h-14 w-full rounded-2xl border-2 border-dashed border-line font-bold text-accent-text">＋ {t("addToRecipe")}</button>}
 <button type="button" onClick={()=>setMath(v=>!v)} className="mt-3 min-h-12 w-full text-sm font-bold text-accent-text">{math?t("hideUnitMath"):t("showUnitMath")} <ChevronDown className="inline size-4"/></button>
 {error&&<p role="alert" className="mt-2 text-warn">{error}</p>}{saved&&<p role="status" className="mt-2 text-good">{t("saved")}</p>}
 <div className="sticky bottom-24 z-20 mt-6 rounded-2xl border border-line bg-card p-3 shadow-xl lg:absolute lg:end-0 lg:top-0 lg:bottom-auto lg:mt-0 lg:w-[290px] lg:shadow-none"><h2 className="mb-3 hidden font-headline text-xl font-extrabold lg:block">{t("whatYouKeep")}</h2><div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:flex lg:flex-col">{selectedItems.map(item=>{const p=prices[item.id];return <div key={item.id} className="min-w-0 rounded-xl bg-paper p-2 text-center text-[13px]"><p className="font-bold">{item.sizeLabel??item.name}</p><p>{t("cost")} {p?.cost===null?"—":formatCents(p.cost)}</p><p>{t("price")} {formatCents(item.priceCents)}</p><p className="font-extrabold text-good">{p?.summary.keepCents===null?"—":t("keep",{amount:formatCents(p.summary.keepCents),percent:p.summary.keepPercent ?? 0})}</p>{p?.estimated&&<p className="text-warn">{t("estimate")}</p>}</div>})}</div><button type="button" onClick={save} disabled={pending||selectedItems.length===0} className="mt-3 min-h-14 w-full rounded-xl bg-accent font-bold text-on-accent disabled:opacity-50">{t("saveItem",{name:items[0]?.baseName??""})}</button></div>
 {toast&&<div role="status" className="fixed bottom-40 start-4 z-30 flex items-center gap-2 rounded-2xl bg-ink px-4 py-3 text-card">{t("removed",{name:toast})} · <button type="button" onClick={undo} className="min-h-10 font-bold underline">{t("undo")}</button></div>}
 {priceDraft&&<div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"><div className="w-full max-w-sm rounded-t-2xl bg-card p-5 text-ink sm:rounded-2xl"><h2 className="mb-3 font-headline text-xl font-bold">{t("setPrice")}</h2><label className="block font-bold">{t("itemPrice")}<input autoFocus type="number" min=".01" step=".01" value={draftPrice} onChange={e=>setDraftPrice(e.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-line bg-card px-3"/></label><div className="mt-4 flex gap-2"><button type="button" className="min-h-12 flex-1 rounded-xl border border-line" onClick={()=>setPriceDraft(null)}>{t("cancel")}</button><button type="button" disabled={pending||!(Number(draftPrice)>0)} className="min-h-12 flex-1 rounded-xl bg-accent text-on-accent" onClick={saveDraftSizePrice}>{t("save")}</button></div></div></div>}
 {sizeDialog&&items[0]&&<AddSizeDialog baseName={items[0].baseName} category={items[0].category} menuGroup={items[0].menuGroup} siblingSizes={items.map(item=>({id:item.id,name:item.name,sizeLabel:item.sizeLabel,priceCents:item.priceCents}))} onDone={()=>{setSizeDialog(false);router.refresh();}} onClose={()=>setSizeDialog(false)}/>}
 {swap&&<div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"><div className="max-h-[85dvh] w-full max-w-xl overflow-y-auto rounded-t-[28px] bg-card p-5 text-ink"><h2 className="mb-4 font-headline text-xl font-bold">{t("swapFor",{name:ingredientRows.find(x=>x[0]===swap)?.[1]??""})}</h2><div className="divide-y divide-line">{swapChoices.map(i=>{const diff=swapPrice(i);const drinkCost=swapDrinkCost(i);const changed=diff!==null?Math.round(diff):null;return <label key={i.id} className="flex min-h-16 items-center gap-3"><input type="radio" name="swap" checked={choice===i.id} onChange={()=>setChoice(i.id)}/><span className="min-w-0 flex-1"><span className="block font-bold">{i.name}</span><span className="block text-[13px] text-ink-muted">{drinkCost===null?t("estimate"):`${t("costPerDrink")} ${formatCents(drinkCost)}`}</span></span>{i.id===swap?<span className="text-sm text-ink-muted">{t("current")}</span>:changed===null?<span className="rounded-full bg-warn-soft px-2 text-[13px] text-warn">{t("estimate")}</span>:<span className={changed>0?"font-bold text-warn":changed<0?"font-bold text-good":"text-ink-muted"}>{changed>0?"+":changed<0?"−":""}{formatCents(Math.abs(changed))}</span>}</label>})}</div><div className="mt-4 flex gap-2"><button onClick={()=>setSwap(null)} className="min-h-12 flex-1 rounded-xl border border-line">{t("cancel")}</button><button disabled={pending||!choice||choice===swap} onClick={performSwap} className="min-h-12 flex-1 rounded-xl bg-accent text-on-accent disabled:opacity-50">{t("swapTo",{name:ingredients.find(i=>i.id===choice)?.name??""})}</button></div></div></div>}
 </div>;
}
