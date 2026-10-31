"use client";
import {Fragment,useState,useTransition} from "react";
import {useTranslations} from "next-intl";
import {Plus,X,ArrowLeftRight} from "lucide-react";
import {useRouter} from "@/i18n/navigation";
import {saveProductRecipes,createPantryIngredient} from "@/lib/actions/pantry";
import {updateMenuItemPrice,setMenuItemActive} from "@/lib/actions/menuItems";
import type {UnpricedMenuSize} from "@/lib/data/getUnpricedProductSizes";
import {swapIngredient} from "@/lib/actions/pantry";
import {recipeDisplayUnitsFor,needsIngredientConversion} from "@/lib/calc/recipeUnits";
import type {RecipeDisplayUnit,IngredientUnitConversion} from "@/lib/calc/recipeUnits";
import type {IngredientOption,MenuItemForEdit} from "@/lib/data/getMenuItemsForEdit";
import {keepPreview,draftRecipeCosts} from "@/lib/calc/recipePreview";
import {formatCents} from "@/lib/calc";
import AddSizeDialog from "./AddSizeDialog";
import type {PricedPantry} from "./MenuAddonsPanel";
import {toBaseUnitQuantity} from "@/lib/calc/recipeUnits";
import {swapPortionDifferenceCents,additiveCostCents} from "@/lib/calc/menuAddons";
type Draft={unit:RecipeDisplayUnit;quantity:number;removed:boolean};
function k(item:string,ingredient:string){return item+":"+ingredient;}
export default function AllSizesRecipe({items,ingredients,conversions,pantry,draftSizes}:{items:MenuItemForEdit[];ingredients:IngredientOption[];conversions:Record<string,IngredientUnitConversion[]>;pantry:PricedPantry[];draftSizes:UnpricedMenuSize[]}){
 const t=useTranslations("MenuBuilder"),units=useTranslations("ManageMenu"),router=useRouter();const [pending,start]=useTransition(),[error,setError]=useState(""),[saved,setSaved]=useState(false);
 const [active,setActive]=useState<string[]>(items.filter(i=>i.active).map(i=>i.id));
 const [focusedSize,setFocusedSize]=useState(items.find(i=>i.active)?.id??items[0]?.id??"");
 const [searchIngredient,setSearchIngredient]=useState("");
 const [drafts,setDrafts]=useState<Record<string,Draft>>(()=>Object.fromEntries(items.flatMap(item=>item.recipe.map(line=>[k(item.id,line.ingredientId),{quantity:line.displayQuantity??line.quantity,unit:(line.displayUnit??line.baseUnit) as RecipeDisplayUnit,removed:false}]))));
 const [priceDraft,setPriceDraft]=useState<string|null>(null),[draftPrice,setDraftPrice]=useState("");
 const [sizeDialog,setSizeDialog]=useState(false);const [add,setAdd]=useState<string|null>(null),[addAfter,setAddAfter]=useState<string>("top"),[swap,setSwap]=useState<string|null>(null),[choice,setChoice]=useState(""),[toast,setToast]=useState("");
 const [swapSizeId,setSwapSizeId]=useState<string|null>(null);
 const [quantityInputs,setQuantityInputs]=useState<Record<string,string>>({});
 const [newRowAmount,setNewRowAmount]=useState("1"),[newRowUnit,setNewRowUnit]=useState<RecipeDisplayUnit>("ml");
 const [newPantry,setNewPantry]=useState(false),[newPantryName,setNewPantryName]=useState(""),[newPantryUnit,setNewPantryUnit]=useState<"g"|"ml"|"each">("ml");
 const selectedItems=items.filter(i=>i.id===focusedSize), ingredientRows=[...new Map(selectedItems.flatMap(item=>item.recipe.map(line=>[line.ingredientId,line.ingredientName] as const))).entries()];
 const hasUnsavedChanges=Object.entries(drafts).some(([key,d])=>{
  for(const item of items){for(const line of item.recipe){if(key===k(item.id,line.ingredientId))return d.removed||d.quantity!==(line.displayQuantity??line.quantity)||d.unit!==(line.displayUnit??line.baseUnit);}}
  return false;
 });
 const mobileColumns={gridTemplateColumns:`repeat(${Math.max(1,Math.min(3,selectedItems.length))},minmax(0,1fr))`};
 const invalidQuantity=Object.values(quantityInputs).some(value=>value.trim()===""||!Number.isFinite(Number(value))||Number(value)<=0);
 const prices=Object.fromEntries(selectedItems.map(item=>{
  const preview=draftRecipeCosts(item.recipe.map(line=>{
   const d=drafts[k(item.id,line.ingredientId)];
   return {
    ingredientId:line.ingredientId,originalBaseQuantity:line.quantity,baseUnit:line.baseUnit,
    costCents:line.costCents,displayUnit:d?.unit??(line.displayUnit??line.baseUnit) as RecipeDisplayUnit,
    displayQuantity:d?.quantity??line.displayQuantity??line.quantity,
    removed:d?.removed??false,conversions:conversions[line.ingredientId]??[],
   };
  }));
  const cost=preview.costCents??(item.costSource==="owner_total"?item.ownerTotalCostCents??null:null);
  return [item.id,{cost,summary:keepPreview(item.priceCents,cost),
   lineCosts:preview.lineCosts,estimated:preview.estimated||item.costSource==="owner_total"||item.ownerTotalCostStatus==="estimated"}];
 }));
 function removeRow(id:string){const item=selectedItems[0],line=item?.recipe.find(l=>l.ingredientId===id);if(!item||!line)return;
  const key=k(item.id,id);setQuantityInputs(prev=>Object.fromEntries(Object.entries(prev).filter(([entry])=>entry!==key)));
  setDrafts(prev=>({...prev,[key]:{...prev[key],unit:(prev[key]?.unit??line.displayUnit??line.baseUnit) as RecipeDisplayUnit,quantity:prev[key]?.quantity??line.displayQuantity??line.quantity,removed:true}}));
  setToast(line.ingredientName);setSaved(false);
 }
 function undo(){const id=ingredientRows.find(row=>row[1]===toast)?.[0],item=selectedItems[0];if(!id||!item)return;setDrafts(prev=>({...prev,[k(item.id,id)]:{...prev[k(item.id,id)],removed:false}}));setToast("");}
 function recipeChanges(newIngredientId?:string){
  return selectedItems.map(item=>({
   itemId:item.id,
   expected:item.recipe.map(line=>({ingredientId:line.ingredientId,quantity:line.quantity,displayUnit:line.displayUnit,displayQuantity:line.displayQuantity})),
   lines:[
    ...item.recipe.flatMap(line=>{
      const d=drafts[k(item.id,line.ingredientId)];
      if(d?.removed||d?.quantity===0)return [];
      return [{ingredientId:line.ingredientId,displayUnit:(d?.unit??line.displayUnit??line.baseUnit) as RecipeDisplayUnit,displayQuantity:d?.quantity??line.displayQuantity??line.quantity}];
    }),
    ...(newIngredientId?(()=>{
      const ingredient=ingredients.find(i=>i.id===newIngredientId);
      return ingredient&&!item.recipe.some(line=>line.ingredientId===ingredient.id)?[{ingredientId:ingredient.id,displayUnit:newRowUnit,displayQuantity:Number(newRowAmount)}]:[];
    })():[])
   ],
  }));
 }
 function save(){if(!selectedItems[0]||invalidQuantity)return;setError("");start(async()=>{
  const result=await saveProductRecipes({productId:selectedItems[0].id,sizes:recipeChanges()});
  if(!result.ok){setError(t("error"));return;}
  setSaved(true);setToast("");router.refresh();
 });}
 function append(){if(!add||!selectedItems[0]||selectedItems.length===0||!(Number(newRowAmount)>0))return;
  setError("");start(async()=>{
   const result=await saveProductRecipes({productId:selectedItems[0].id,sizes:recipeChanges(add)});
   if(!result.ok){setError(t("error"));return;}
   setAdd(null);router.refresh();
  });
 }
 function saveDraftSizePrice(){if(!priceDraft)return;const cents=Math.round(Number(draftPrice)*100);if(!Number.isSafeInteger(cents)||cents<=0)return;start(async()=>{const result=await updateMenuItemPrice({menuItemId:priceDraft,priceCents:cents});if(!result.ok)setError(result.error);else{setPriceDraft(null);router.refresh();}});}
 function openSwap(id:string){if(hasUnsavedChanges){setError(t("saveBeforeSwap"));return;}setError("");setSwap(id);setChoice(id);setSwapSizeId(selectedItems.find(item=>item.recipe.some(line=>line.ingredientId===id))?.id??null);}
 function toggleSize(item:MenuItemForEdit){
  if(hasUnsavedChanges){setError(t("saveBeforeSizeChange"));return;}
  setError("");start(async()=>{
   const result=await setMenuItemActive(item.id,!item.active);
   if(!result.ok){setError(t("error"));return;}
   setActive(prev=>item.active?prev.filter(x=>x!==item.id):[...prev,item.id]);router.refresh();
  });
 }
 function performSwap(){if(!swap||!choice)return;start(async()=>{const result=await swapIngredient(items[0].id,swap,choice);if(!result.ok)setError(t("error"));else{setSwap(null);router.refresh();}});}
 const source=pantry.find(p=>p.id===swap);
 const representative=selectedItems.find(item=>item.id===swapSizeId&&item.recipe.some(line=>line.ingredientId===swap))??selectedItems.find(item=>item.recipe.some(line=>line.ingredientId===swap));
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
 function beginAddRow(after:string){setAdd("");setAddAfter(after);setNewRowAmount("1");setSearchIngredient("");setError("");}
 function createPantry(){if(!newPantryName.trim())return;setError("");start(async()=>{
  const result=await createPantryIngredient({name:newPantryName.trim(),category:"other",baseUnit:newPantryUnit});
  if(!result.ok){setError(t("error"));return;}setNewPantry(false);setNewPantryName("");router.refresh();
 });}
 function addPicker(){return <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft p-3">
  <label className="min-w-[160px] flex-1 text-[13px] font-bold">{t("addRecipeRow")}
   <input autoFocus value={searchIngredient} onChange={e=>{setSearchIngredient(e.target.value);setAdd("");}} placeholder={t("search")} aria-label={t("search")} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px]"/>
   <select className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px]" aria-label={t("addToRecipe")} value={add??""} onChange={e=>{setAdd(e.target.value);setNewRowUnit(ingredients.find(ingredient=>ingredient.id===e.target.value)?.baseUnit??"ml");}}>
   <option value="">{t("addToRecipe")}</option>{ingredients.filter(i=>selectedItems.some(item=>!item.recipe.some(line=>line.ingredientId===i.id))&&i.name.toLocaleLowerCase().includes(searchIngredient.toLocaleLowerCase())).map(i=><option key={i.id} value={i.id}>{i.name}</option>)}
  </select></label>
  <label className="w-24 text-[13px] font-bold">{t("quantity")}<input type="number" min="0.0001" step="any" inputMode="decimal" value={newRowAmount} onChange={e=>setNewRowAmount(e.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-2 text-[17px]"/></label>
  <label className="min-w-[105px] text-[13px] font-bold">{t("unit")}<select value={newRowUnit} onChange={e=>setNewRowUnit(e.target.value as RecipeDisplayUnit)} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-2 text-[17px]">{(add?recipeDisplayUnitsFor(ingredients.find(ingredient=>ingredient.id===add)?.baseUnit??"ml",conversions[add]??[]):[]).filter(unit=>!needsIngredientConversion(unit)||(conversions[add??""]??[]).some(c=>c.unit===unit)).map(unit=><option key={unit} value={unit}>{unitLabel(unit)}</option>)}</select></label>
  <button type="button" disabled={pending||!add||invalidQuantity||!(Number(newRowAmount)>0)} onClick={append} className="min-h-12 rounded-xl bg-accent px-4 font-bold text-on-accent disabled:opacity-50">{t("add")}</button>
  <button type="button" onClick={()=>setAdd(null)} className="min-h-12 px-3">{t("cancel")}</button></div>;}
 /** Use the one canonical unit-compatibility helper; no parallel conversion rules in the UI. */
 function availableUnits(line:MenuItemForEdit["recipe"][number]):RecipeDisplayUnit[]{
  return recipeDisplayUnitsFor(line.baseUnit,conversions[line.ingredientId]??[]).filter(unit=>
   !needsIngredientConversion(unit)||(conversions[line.ingredientId]??[]).some(c=>c.unit===unit)||unit===(line.displayUnit??line.baseUnit));
 }
 function unitLabel(unit:RecipeDisplayUnit){
  return ({shot:units("recipeUnitShot"),pump:units("recipeUnitPump"),g:units("recipeUnitG"),ml:units("recipeUnitMl"),fl_oz:units("recipeUnitFlOz"),each:units("recipeUnitEach")} as Record<RecipeDisplayUnit,string>)[unit];
 }
 function cells(id:string,only?:MenuItemForEdit){return <div className="grid gap-1.5 lg:block" style={mobileColumns}>{(only?[only]:selectedItems).map(item=>{
 const line=item.recipe.find(l=>l.ingredientId===id),draft=drafts[k(item.id,id)];
 if(!line||draft?.removed)return <p key={item.id} className="p-2 text-center text-ink-muted">—</p>;
 const actual=draft??{quantity:line.displayQuantity??line.quantity,unit:(line.displayUnit??line.baseUnit) as RecipeDisplayUnit,removed:false};
 const key=k(item.id,id),cost=prices[item.id]?.lineCosts?.[id]??null;
 return <div key={item.id} className="min-w-0"><div className="flex min-w-0 gap-1 rounded-xl bg-paper p-1">
  <input type="number" inputMode="decimal" min="0.0001" step="any" aria-label={t("editQuantityForSize",{ingredient:line.ingredientName,size:item.sizeLabel??item.name})}
   value={quantityInputs[key]??String(actual.quantity)} onChange={e=>{
   const text=e.target.value;setQuantityInputs(prev=>({...prev,[key]:text}));const value=Number(text);
   if(text!==""&&Number.isFinite(value)&&value>0){setDrafts(prev=>({...prev,[key]:{quantity:value,unit:actual.unit,removed:false}}));setSaved(false);}
  }} className="min-h-12 min-w-0 w-full rounded-lg border border-line bg-card px-2 text-center text-[17px] font-bold"/>
  <select aria-label={t("unit")} value={actual.unit} onChange={e=>{
   const unit=e.target.value as RecipeDisplayUnit;setDrafts(prev=>({...prev,[key]:{quantity:actual.quantity,unit,removed:false}}));setSaved(false);
  }} className="min-h-12 w-[95px] shrink-0 rounded-lg border border-line bg-card px-1 text-[15px]">{availableUnits(line).map(u=><option key={u} value={u}>{unitLabel(u)}</option>)}</select>
 </div><p className="mt-1 text-center text-[13px] text-ink-muted">{cost===null?"—":formatCents(cost)}</p></div>;
 })}</div>;}
 return <div className="relative pb-24 text-ink">
 <div className="mb-3 flex flex-wrap items-center gap-2">
  <span className="font-bold">{t("sizesSell")}</span>
  {items.map(item=><button key={item.id} type="button" aria-pressed={focusedSize===item.id} onClick={()=>{if(hasUnsavedChanges||invalidQuantity){setError(t("saveBeforeSizeChange"));return;}setFocusedSize(item.id);setAdd(null);setToast("");setError("");}} className={`min-h-12 rounded-full border px-4 font-bold ${focusedSize===item.id?"border-accent bg-accent text-on-accent":"border-line bg-card"}`}>{item.sizeLabel??item.name}{!active.includes(item.id)?" · "+t("priceNotSet"):""}</button>)}
  {draftSizes.map(draft=><button key={draft.id} type="button" onClick={()=>{setPriceDraft(draft.id);setDraftPrice("");}} className="min-h-12 rounded-full border border-dashed border-warn px-4">{draft.sizeLabel??draft.name}</button>)}
  <button type="button" onClick={()=>setSizeDialog(true)} className="min-h-12 rounded-full border border-dashed border-accent px-4 text-accent-text">{t("addSize")}</button>
 </div>
 <button type="button" disabled={pending||!selectedItems[0]} onClick={()=>selectedItems[0]&&toggleSize(selectedItems[0])} className="mb-3 min-h-12 rounded-xl border border-line px-4 text-[17px]">{active.includes(focusedSize)?units("remove"):units("add")}</button>
 <div className="mb-3 flex flex-wrap gap-2"><button type="button" onClick={()=>beginAddRow("top")} className="min-h-12 rounded-xl border border-line bg-card px-4 font-bold text-accent-text"><Plus className="me-1 inline size-4"/>{t("addRecipeRow")}</button><button type="button" onClick={()=>setNewPantry(v=>!v)} className="min-h-12 rounded-xl bg-accent px-4 font-bold text-on-accent"><Plus className="me-1 inline size-4"/>{t("addPantryItem")}</button></div>
 {newPantry&&<div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-card p-3"><label className="min-w-[180px] flex-1">{t("newIngredient")}<input autoFocus className="mt-1 min-h-12 w-full rounded-lg border border-line bg-card px-3" value={newPantryName} onChange={e=>setNewPantryName(e.target.value)}/></label><label>{t("measurementType")}<select className="mt-1 min-h-12 w-full rounded-lg border border-line bg-card px-2" value={newPantryUnit} onChange={e=>setNewPantryUnit(e.target.value as "g"|"ml"|"each")}><option value="ml">{t("liquidMeasurement")}</option><option value="g">{t("weightMeasurement")}</option><option value="each">{t("pieceMeasurement")}</option></select></label><button type="button" disabled={pending||!newPantryName.trim()} onClick={createPantry} className="min-h-12 rounded-xl bg-accent px-4 font-bold text-on-accent">{t("create")}</button><button type="button" className="min-h-12 px-3" onClick={()=>setNewPantry(false)}>{t("cancel")}</button></div>}
 {add!==null&&addAfter==="top"&&addPicker()}
 <div className="mb-2 grid gap-1.5 lg:hidden" style={mobileColumns}>{selectedItems.map(item=><div key={item.id} className="rounded-xl bg-paper p-2 text-center font-bold">{item.sizeLabel??item.name}</div>)}</div>
 <div className="space-y-2 lg:hidden">{ingredientRows.map(([id,name])=><div key={id} className="rounded-2xl border border-line bg-card p-3"><div className="mb-2 flex min-h-12 items-center gap-2"><strong className="min-w-0 flex-1 break-words">{name}</strong><button type="button" onClick={()=>beginAddRow(id)} aria-label={t("addRecipeRowAfter",{name})} className="flex min-h-12 min-w-12 items-center justify-center rounded-xl bg-accent-soft text-accent-text"><Plus size={18}/></button><button type="button" onClick={()=>openSwap(id)} className="min-h-12 rounded-xl bg-paper px-2 text-[13px] font-bold text-accent-text"><ArrowLeftRight size={15} className="me-1 inline"/>{t("swap")}</button><button type="button" aria-label={t("remove")} onClick={()=>removeRow(id)} className="flex min-h-12 min-w-12 items-center justify-center rounded-full bg-paper"><X size={17}/></button></div>{cells(id)}{add!==null&&addAfter===id&&<div className="mt-3">{addPicker()}</div>}</div>)}</div>
 <div className="hidden overflow-x-auto rounded-2xl border border-line bg-card lg:block"><table className="w-full table-fixed"><thead><tr className="border-b border-line bg-paper"><th className="w-[28%] p-3 text-start">{t("name")}</th>{selectedItems.map(item=><th key={item.id} className="p-3">{item.sizeLabel??item.name}</th>)}</tr></thead><tbody>{ingredientRows.map(([id,name])=><Fragment key={id}><tr className="border-b border-line"><th className="p-3 text-start"><div className="flex items-center gap-2"><span className="min-w-0 flex-1">{name}</span><button type="button" onClick={()=>beginAddRow(id)} aria-label={t("addRecipeRowAfter",{name})} className="flex min-h-12 min-w-12 items-center justify-center rounded-xl bg-accent-soft text-accent-text"><Plus size={18}/></button></div><div><button type="button" className="min-h-12 text-sm text-accent-text" onClick={()=>openSwap(id)}>{t("swap")}</button><button type="button" className="ms-2 min-h-12 text-sm text-warn" onClick={()=>removeRow(id)}>{t("remove")}</button></div></th>{selectedItems.map(item=><td key={item.id} className="p-2">{cells(id,item)}</td>)}</tr>{add!==null&&addAfter===id&&<tr><td colSpan={selectedItems.length+1} className="p-2">{addPicker()}</td></tr>}</Fragment>)}</tbody></table></div>
 {error&&<p role="alert" className="mt-2 text-warn">{error}</p>}{saved&&<p role="status" className="mt-2 text-good">{t("saved")}</p>}
 <div className="sticky bottom-24 z-20 mt-6 rounded-2xl border border-line bg-card p-3 shadow-xl"><h2 className="mb-3 font-headline text-xl font-extrabold">{t("whatYouKeep")}</h2><div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:flex lg:flex-col">{selectedItems.map(item=>{const p=prices[item.id];return <div key={item.id} className="min-w-0 rounded-xl bg-paper p-2 text-center text-[13px]"><p className="font-bold">{item.sizeLabel??item.name}</p><p>{t("cost")} {p?.cost===null?"—":formatCents(p.cost)}</p><p>{t("price")} {formatCents(item.priceCents)}</p><p className="font-extrabold text-good">{p?.summary.keepCents===null?"—":t("keep",{amount:formatCents(p.summary.keepCents),percent:p.summary.keepPercent ?? 0})}</p>{p?.estimated&&<p className="text-warn">{t("estimate")}</p>}</div>})}</div><button type="button" onClick={save} disabled={pending||invalidQuantity||selectedItems.length===0} className="mt-3 min-h-14 w-full rounded-xl bg-accent font-bold text-on-accent disabled:opacity-50">{t("saveItem",{name:items[0]?.baseName??""})}</button></div>
 {toast&&<div role="status" className="fixed bottom-40 start-4 z-30 flex items-center gap-2 rounded-2xl bg-ink px-4 py-3 text-card">{t("removed",{name:toast})} · <button type="button" onClick={undo} className="min-h-10 font-bold underline">{t("undo")}</button></div>}
 {priceDraft&&<div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"><div className="w-full max-w-sm rounded-t-2xl bg-card p-5 text-ink sm:rounded-2xl"><h2 className="mb-3 font-headline text-xl font-bold">{t("setPrice")}</h2><label className="block font-bold">{t("itemPrice")}<input autoFocus type="number" min=".01" step=".01" value={draftPrice} onChange={e=>setDraftPrice(e.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-line bg-card px-3"/></label><div className="mt-4 flex gap-2"><button type="button" className="min-h-12 flex-1 rounded-xl border border-line" onClick={()=>setPriceDraft(null)}>{t("cancel")}</button><button type="button" disabled={pending||!(Number(draftPrice)>0)} className="min-h-12 flex-1 rounded-xl bg-accent text-on-accent" onClick={saveDraftSizePrice}>{t("save")}</button></div></div></div>}
 {sizeDialog&&items[0]&&<AddSizeDialog baseName={items[0].baseName} category={items[0].category} menuGroup={items[0].menuGroup} siblingSizes={items.map(item=>({id:item.id,name:item.name,sizeLabel:item.sizeLabel,priceCents:item.priceCents}))} onDone={()=>{setSizeDialog(false);router.refresh();}} onClose={()=>setSizeDialog(false)}/>}
 {swap&&<div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"><div className="max-h-[85dvh] w-full max-w-xl overflow-y-auto rounded-t-[28px] bg-card p-5 text-ink"><h2 className="mb-4 font-headline text-xl font-bold">{t("swapFor",{name:ingredientRows.find(x=>x[0]===swap)?.[1]??""})}</h2><div className="mb-3 flex flex-wrap gap-2" aria-label={t("sizesSell")}>{selectedItems.filter(item=>item.recipe.some(line=>line.ingredientId===swap)).map(item=><button key={item.id} type="button" aria-pressed={swapSizeId===item.id} onClick={()=>setSwapSizeId(item.id)} className={`min-h-12 rounded-full border px-3 font-bold ${swapSizeId===item.id?"border-accent bg-accent text-on-accent":"border-line bg-card"}`}>{item.sizeLabel??item.name}</button>)}</div><div className="divide-y divide-line">{swapChoices.map(i=>{const diff=swapPrice(i);const drinkCost=swapDrinkCost(i);const changed=diff!==null?Math.round(diff):null;return <label key={i.id} className="flex min-h-16 items-center gap-3"><input type="radio" name="swap" checked={choice===i.id} onChange={()=>setChoice(i.id)}/><span className="min-w-0 flex-1"><span className="block font-bold">{i.name}</span><span className="block text-[13px] text-ink-muted">{drinkCost===null?t("estimate"):`${t("costPerDrink")} ${formatCents(drinkCost)}`}</span></span>{i.id===swap?<span className="text-sm text-ink-muted">{t("current")}</span>:changed===null?<span className="rounded-full bg-warn-soft px-2 text-[13px] text-warn">{t("estimate")}</span>:<span className={changed>0?"font-bold text-neg":changed<0?"font-bold text-pos":"text-ink-muted"}>{changed>0?"+":changed<0?"−":""}{formatCents(Math.abs(changed))}</span>}</label>})}</div><div className="mt-4 flex gap-2"><button onClick={()=>setSwap(null)} className="min-h-12 flex-1 rounded-xl border border-line">{t("cancel")}</button><button disabled={pending||!choice||choice===swap} onClick={performSwap} className="min-h-12 flex-1 rounded-xl bg-accent text-on-accent disabled:opacity-50">{t("swapTo",{name:ingredients.find(i=>i.id===choice)?.name??""})}</button></div></div></div>}
 </div>;
}
