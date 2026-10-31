"use client";
import {Fragment,useEffect,useState,useTransition} from "react";
import {useTranslations} from "next-intl";
import {Plus,X,ArrowLeftRight} from "lucide-react";
import {useRouter} from "@/i18n/navigation";
import {saveProductRecipes} from "@/lib/actions/pantry";
import NewPantryInlineRow from "./NewPantryInlineRow";
import {setIngredientUnitConversion} from "@/lib/actions/ingredientUnitConversions";
import {suggestedRecipeMeasure,suggestedIngredientDensity} from "@/lib/calc/suggestedRecipeMeasures";
import {densityFromStoredRecipe,reexpressRecipeQuantity} from "@/lib/calc/recipeUnits";
import {updateMenuItemPrice,setMenuItemActive} from "@/lib/actions/menuItems";
import type {UnpricedMenuSize} from "@/lib/data/getUnpricedProductSizes";
import {recipeDisplayUnitsFor,needsIngredientConversion} from "@/lib/calc/recipeUnits";
import type {RecipeDisplayUnit,IngredientUnitConversion} from "@/lib/calc/recipeUnits";
import type {IngredientOption,MenuItemForEdit} from "@/lib/data/getMenuItemsForEdit";
import {keepPreview,draftRecipeCosts} from "@/lib/calc/recipePreview";
import {formatCents} from "@/lib/calc";
import AddSizeDialog from "./AddSizeDialog";
import type {PricedPantry} from "./MenuAddonsPanel";
type Draft={unit:RecipeDisplayUnit;quantity:number;removed:boolean};
function k(item:string,ingredient:string){return item+":"+ingredient;}
/** A replacement ingredient must never inherit the original ingredient's density.
 * Cross weight/volume conversions require the replacement's confirmed density. */
export function safeRecipeDensity(replacing:boolean,raw:string|undefined,
  stored:number|null|undefined,suggested:number|null|undefined):number|undefined{
 if(raw!==undefined){
  const value=Number(raw);
  return raw.trim()!==""&&Number.isFinite(value)&&value>0&&value<=5?value:undefined;
 }
 return replacing?undefined:stored??suggested??undefined;
}
/** Keep a saved recipe's physical amount intact when its ingredient changes.
 * Both conversions use the one canonical unit conversion routine. */
export function preservedReplacementQuantity(unit:RecipeDisplayUnit,amount:number,
 base:"g"|"ml"|"each",original:IngredientUnitConversion[],replacement:IngredientUnitConversion[]):number|null{
 const baseAmount=reexpressRecipeQuantity(unit,base,amount,base,original);
 return baseAmount===null?null:reexpressRecipeQuantity(base,unit,baseAmount,base,replacement);
}
export default function AllSizesRecipe({items,ingredients,conversions,draftSizes,focusedSizeId,onFocusedSizeChange,onDraftDirtyChange}:{items:MenuItemForEdit[];ingredients:IngredientOption[];conversions:Record<string,IngredientUnitConversion[]>;pantry:PricedPantry[];draftSizes:UnpricedMenuSize[];focusedSizeId?:string;onFocusedSizeChange?:(id:string)=>void;onDraftDirtyChange?:(dirty:boolean)=>void}){
 const t=useTranslations("MenuBuilder"),units=useTranslations("ManageMenu"),menu=useTranslations("Menu"),router=useRouter();const [pending,start]=useTransition(),[error,setError]=useState(""),[saved,setSaved]=useState(false);
 // Serving status is supplied by the canonical parent after refresh. Keep the
 // recipe drafts mounted while reading updated status, without effect-setState.
 const active=items.filter(i=>i.active).map(i=>i.id);
 const [focusedSize,setFocusedSize]=useState(focusedSizeId&&items.some(i=>i.id===focusedSizeId)?focusedSizeId:items.find(i=>i.active)?.id??items[0]?.id??"");
 const [searchIngredient,setSearchIngredient]=useState("");
 const [drafts,setDrafts]=useState<Record<string,Draft>>(()=>Object.fromEntries(items.flatMap(item=>item.recipe.map(line=>[k(item.id,line.ingredientId),{quantity:line.displayQuantity??line.quantity,unit:(line.displayUnit??line.baseUnit) as RecipeDisplayUnit,removed:false}]))));
 const [priceDraft,setPriceDraft]=useState<string|null>(null),[draftPrice,setDraftPrice]=useState("");
 const [sizeDialog,setSizeDialog]=useState(false);const [add,setAdd]=useState<string|null>(null),[addAfter,setAddAfter]=useState<string>("top"),[toast,setToast]=useState("");
 const [lastRemovedId,setLastRemovedId]=useState<string|null>(null);
 const [editingIngredient,setEditingIngredient]=useState<string|null>(null),[replacements,setReplacements]=useState<Record<string,string>>({});
 const [quantityInputs,setQuantityInputs]=useState<Record<string,string>>({});
 const [calibration,setCalibration]=useState<Record<string,string>>({});
 const [densityInputs,setDensityInputs]=useState<Record<string,string>>({});
 const [newRowAmount,setNewRowAmount]=useState("1"),[newRowUnit,setNewRowUnit]=useState<RecipeDisplayUnit>("ml"),[newRowDensity,setNewRowDensity]=useState("");
 const [newPantry,setNewPantry]=useState(false);
 const selectedItems=items.filter(i=>i.id===focusedSize), ingredientRows=[...new Map(selectedItems.flatMap(item=>item.recipe.filter(line=>!drafts[k(item.id,line.ingredientId)]?.removed).map(line=>[line.ingredientId,line.ingredientName] as const))).entries()];
 const hasUnsavedChanges=Object.keys(replacements).length>0||Object.entries(drafts).some(([key,d])=>{
  for(const item of items){for(const line of item.recipe){if(key===k(item.id,line.ingredientId))return d.removed||d.quantity!==(line.displayQuantity??line.quantity)||d.unit!==(line.displayUnit??line.baseUnit);}}
  return false;
 });
 const mobileColumns={gridTemplateColumns:`repeat(${Math.max(1,Math.min(3,selectedItems.length))},minmax(0,1fr))`};
 const invalidQuantity=Object.values(quantityInputs).some(value=>value.trim()===""||!Number.isFinite(Number(value))||Number(value)<=0);
 // Preserve drafts when the adjacent product card changes a price or serving status.
 const editorDraftDirty=hasUnsavedChanges||invalidQuantity||Object.keys(calibration).length>0||
  Object.keys(densityInputs).length>0||newPantry||add!==null;
 useEffect(()=>{onDraftDirtyChange?.(editorDraftDirty);},[editorDraftDirty,onDraftDirtyChange]);
 function requiresDensity(base:"g"|"ml"|"each",unit:RecipeDisplayUnit){
  return (base==="ml"&&unit==="g")||(base==="g"&&(unit==="ml"||unit==="fl_oz"));
 }
 function effectiveIngredient(item:MenuItemForEdit,line:MenuItemForEdit["recipe"][number]){
  const id=replacements[k(item.id,line.ingredientId)]??line.ingredientId;
  return {id,name:ingredients.find(i=>i.id===id)?.name??line.ingredientName};
 }
 function densityFor(item:MenuItemForEdit,line:MenuItemForEdit["recipe"][number],unit:RecipeDisplayUnit,sourceUnit:RecipeDisplayUnit=unit):number|undefined{
  // A conversion may need density to interpret its SOURCE, even if its destination
  // is the base unit. E.g. 103 g -> 100 ml milk needs 1.03 g/ml.
  if(!requiresDensity(line.baseUnit,unit)&&!requiresDensity(line.baseUnit,sourceUnit))return undefined;
  const key=k(item.id,line.ingredientId),userInput=densityInputs[key];
  const replacing=Boolean(replacements[key]&&replacements[key]!==line.ingredientId);
  const existing=densityFromStoredRecipe(line.baseUnit,line.quantity,(line.displayUnit??line.baseUnit) as RecipeDisplayUnit,line.displayQuantity??line.quantity);
  return safeRecipeDensity(replacing,userInput,existing,suggestedIngredientDensity(line.ingredientName));
 }
 const invalidDensity=selectedItems.some(item=>item.recipe.some(line=>{
  const draft=drafts[k(item.id,line.ingredientId)],unit=(draft?.unit??line.displayUnit??line.baseUnit) as RecipeDisplayUnit;
  return !draft?.removed&&requiresDensity(line.baseUnit,unit)&&densityFor(item,line,unit)===undefined;
 }));
 function conversionFor(id:string):IngredientUnitConversion[]{
  // Both source and destination operational units must use the selected
  // ingredient's saved or pending calibration, never the replaced ingredient's.
  const latest=[...(conversions[id]??[])];
  for(const unit of ["shot","pump"] as const){
   const raw=calibration[id+":"+unit];
   if(raw===undefined)continue;
   const previous=latest.findIndex(c=>c.unit===unit);
   if(previous>=0)latest.splice(previous,1);
   const factor=Number(raw);
   if(raw.trim()!==""&&Number.isFinite(factor)&&factor>0)
    latest.push({unit,baseUnitsPerUnit:factor});
  }
  return latest;
 }
 function measureDefault(id:string,name:string,base:"g"|"ml"|"each",unit:RecipeDisplayUnit){
  if(!needsIngredientConversion(unit))return null;
  return (conversions[id]??[]).find(c=>c.unit===unit)?.baseUnitsPerUnit
   ??suggestedRecipeMeasure(name,base,unit)?.baseUnitsPerUnit??null;
 }
 function pendingMeasure(id:string,unit:RecipeDisplayUnit){
  return needsIngredientConversion(unit)&&(!(conversions[id]??[]).some(c=>c.unit===unit)||calibration[id+":"+unit]!==undefined);
 }
 async function saveMeasurements(extra?:{id:string;name:string;base:"g"|"ml"|"each";unit:RecipeDisplayUnit}){
  const entries:Array<{id:string;name:string;base:"g"|"ml"|"each";unit:RecipeDisplayUnit}>=selectedItems.flatMap(item=>item.recipe.flatMap(line=>{
   const draft=drafts[k(item.id,line.ingredientId)];
   if(!draft||draft.removed||!needsIngredientConversion(draft.unit))return [];
    const ingredient=effectiveIngredient(item,line);
    return [{id:ingredient.id,name:ingredient.name,base:line.baseUnit,unit:draft.unit}];
  }));
  if(extra)entries.push(extra);
  const once=new Set<string>();
  for(const entry of entries){
   const key=entry.id+":"+entry.unit;if(once.has(key)||!pendingMeasure(entry.id,entry.unit))continue;once.add(key);
   if(!needsIngredientConversion(entry.unit))continue;
   const raw=calibration[key];
   // An existing recipe with missing calibration cannot silently gain a
   // guessed conversion merely because the owner saved another ingredient.
   const isNewSelection=extra?.id===entry.id&&extra.unit===entry.unit;
   if(raw===undefined&&!isNewSelection){setError(t("measureNeeded"));return false;}
   const factor=Number(raw??measureDefault(entry.id,entry.name,entry.base,entry.unit));
   if(raw===""||!Number.isFinite(factor)||factor<=0){setError(t("measureNeeded"));return false;}
   const saved=await setIngredientUnitConversion({ingredientId:entry.id,unit:entry.unit,baseUnitsPerUnit:factor});
   if(!saved.ok){setError(t("measureSaveError"));return false;}
  }
  return true;
 }
 const prices=Object.fromEntries(selectedItems.map(item=>{
  const preview=draftRecipeCosts(item.recipe.map(line=>{
   const d=drafts[k(item.id,line.ingredientId)];
   // A replacement does not inherit the old ingredient's quantity/cost. Until
   // canonical save/re-read resolves it, show unknown instead of a false margin.
   const currentCost=replacements[k(item.id,line.ingredientId)]?null:line.costCents;
   return {
    ingredientId:line.ingredientId,originalBaseQuantity:line.quantity,baseUnit:line.baseUnit,
    costCents:currentCost,displayUnit:d?.unit??(line.displayUnit??line.baseUnit) as RecipeDisplayUnit,
    displayQuantity:d?.quantity??line.displayQuantity??line.quantity,
    removed:d?.removed??false,conversions:conversionFor(effectiveIngredient(item,line).id),
    densityGramsPerMl:densityFor(item,line,(d?.unit??line.displayUnit??line.baseUnit) as RecipeDisplayUnit),
   };
  }));
  const cost=preview.costCents??(item.costSource==="owner_total"?item.ownerTotalCostCents??null:null);
  return [item.id,{cost,summary:keepPreview(item.priceCents,cost),
   lineCosts:preview.lineCosts,estimated:preview.estimated||item.costSource==="owner_total"||item.ownerTotalCostStatus==="estimated"}];
 }));
 function removeRow(id:string){const item=selectedItems[0],line=item?.recipe.find(l=>l.ingredientId===id);if(!item||!line)return;
  const key=k(item.id,id);setQuantityInputs(prev=>Object.fromEntries(Object.entries(prev).filter(([entry])=>entry!==key)));
  setDrafts(prev=>({...prev,[key]:{...prev[key],unit:(prev[key]?.unit??line.displayUnit??line.baseUnit) as RecipeDisplayUnit,quantity:prev[key]?.quantity??line.displayQuantity??line.quantity,removed:true}}));
  setLastRemovedId(id);setToast(line.ingredientName);setSaved(false);
 }
 function undo(){const id=lastRemovedId,item=selectedItems[0];if(!id||!item)return;setDrafts(prev=>({...prev,[k(item.id,id)]:{...prev[k(item.id,id)],removed:false}}));setToast("");setLastRemovedId(null);}
 function recipeChanges(newIngredientId?:string,newIngredientBase?: "g"|"ml"|"each"){
  return selectedItems.map(item=>({
   itemId:item.id,
   expected:item.recipe.map(line=>({ingredientId:line.ingredientId,quantity:line.quantity,displayUnit:line.displayUnit,displayQuantity:line.displayQuantity})),
   lines:[
    ...item.recipe.flatMap(line=>{
      const d=drafts[k(item.id,line.ingredientId)];
      if(d?.removed||d?.quantity===0)return [];
      const displayUnit=(d?.unit??line.displayUnit??line.baseUnit) as RecipeDisplayUnit;
      return [{ingredientId:replacements[k(item.id,line.ingredientId)]??line.ingredientId,displayUnit,displayQuantity:d?.quantity??line.displayQuantity??line.quantity,
        ...(requiresDensity(line.baseUnit,displayUnit)?{densityGramsPerMl:densityFor(item,line,displayUnit)}:{})}];
    }),
    ...(newIngredientId?(()=>{
      const ingredient=ingredients.find(i=>i.id===newIngredientId)??(newIngredientBase?{id:newIngredientId!,baseUnit:newIngredientBase,name:""}:null);
      return ingredient&&!item.recipe.some(line=>line.ingredientId===ingredient.id)?[{ingredientId:ingredient.id,
        displayUnit:newIngredientBase??newRowUnit,displayQuantity:newIngredientBase?1:Number(newRowAmount),
        ...(requiresDensity(ingredient.baseUnit,newRowUnit)?{densityGramsPerMl:Number(newRowDensity)}:{})}]:[];
    })():[])
   ],
  }));
 }
 function save(){if(!selectedItems[0]||invalidQuantity||invalidDensity){if(invalidDensity)setError(t("densityNeeded"));return;}setError("");start(async()=>{
  if(!await saveMeasurements())return;
  const result=await saveProductRecipes({productId:selectedItems[0].id,sizes:recipeChanges()});
  if(!result.ok){setError(t("error"));return;}
  setSaved(true);setToast("");router.refresh();
 });}
 function append(){if(!add||!selectedItems[0]||selectedItems.length===0||!(Number(newRowAmount)>0))return;
   if(hasUnsavedChanges||invalidQuantity){setError(t("saveBeforeAddingIngredient"));return;}
  const ingredient=ingredients.find(i=>i.id===add);
  if(ingredient&&requiresDensity(ingredient.baseUnit,newRowUnit)&&!(Number(newRowDensity)>0&&Number(newRowDensity)<=5)){setError(t("densityNeeded"));return;}
  setError("");start(async()=>{
   const newIng=ingredients.find(i=>i.id===add);
   if(!await saveMeasurements(newIng?{id:newIng.id,name:newIng.name,base:newIng.baseUnit,unit:newRowUnit}:undefined))return;
   const result=await saveProductRecipes({productId:selectedItems[0].id,sizes:recipeChanges(add)});
   if(!result.ok){setError(t("error"));return;}
   setAdd(null);router.refresh();
  });
 }
 function saveDraftSizePrice(){if(!priceDraft)return;const cents=Math.round(Number(draftPrice)*100);if(!Number.isSafeInteger(cents)||cents<=0)return;start(async()=>{const result=await updateMenuItemPrice({menuItemId:priceDraft,priceCents:cents});if(!result.ok)setError(result.error);else{setPriceDraft(null);router.refresh();}});}
 function openSwap(id:string){setEditingIngredient(current=>current===id?null:id);setError("");}
 function chooseReplacement(id:string,target:string){
  const item=selectedItems[0],line=item?.recipe.find(l=>l.ingredientId===id);
  const ingredient=ingredients.find(i=>i.id===target);
  if(!item||!line||!ingredient||ingredient.baseUnit!==line.baseUnit||
    item.recipe.some(l=>l.ingredientId===target&&l.ingredientId!==id)){
    setError(t("duplicateRecipeIngredient"));return;
  }
  const key=k(item.id,id),current=drafts[key]??{unit:(line.displayUnit??line.baseUnit) as RecipeDisplayUnit,
   quantity:line.displayQuantity??line.quantity,removed:false};
  // Preserve the physical base quantity across calibrated pump/shot swaps.
  // A 10 ml pump cannot silently turn into a 5 ml pump.
  if(target!==id&&needsIngredientConversion(current.unit)){
   const entered=Number(quantityInputs[key]??String(current.quantity));
   const converted=preservedReplacementQuantity(current.unit,entered,line.baseUnit,conversionFor(id),conversionFor(target));
   if(converted===null||!(converted>0)){setError(t("measureNeeded"));return;}
   const amount=Number(converted.toFixed(4));
   setDrafts(prev=>({...prev,[key]:{...current,quantity:amount}}));
   setQuantityInputs(prev=>({...prev,[key]:String(amount)}));
  }
  // Typed/stored density was for the old ingredient; clear it on every swap.
  setDensityInputs(prev=>Object.fromEntries(Object.entries(prev).filter(([entry])=>entry!==key)));
  setReplacements(prev=>target===id?Object.fromEntries(Object.entries(prev).filter(([entry])=>entry!==key)):{...prev,[key]:target});
  setEditingIngredient(null);setSaved(false);setError("");
 }
 function replacementPicker(id:string){
  const item=selectedItems[0],line=item?.recipe.find(l=>l.ingredientId===id);
  if(!item||!line)return null;
  const current=replacements[k(item.id,id)]??id;
  return <select autoFocus value={current} aria-label={t("changeRecipeIngredient",{name:line.ingredientName})}
    onChange={e=>chooseReplacement(id,e.target.value)}
    className="mt-2 min-h-12 w-full rounded-xl border border-line bg-card px-2 text-[17px]">
    <option value={id}>{line.ingredientName}</option>
    {ingredients.filter(i=>i.baseUnit===line.baseUnit&&!item.recipe.some(l=>l.ingredientId===i.id)&&(!needsIngredientConversion((drafts[k(item.id,id)]?.unit??line.displayUnit??line.baseUnit) as RecipeDisplayUnit)||(conversions[i.id]??[]).some(c=>c.unit===(drafts[k(item.id,id)]?.unit??line.displayUnit??line.baseUnit)))).map(i=><option key={i.id} value={i.id}>{i.name}</option>)}
   </select>;
 }
 function toggleSize(item:MenuItemForEdit){
  if(hasUnsavedChanges){setError(t("saveBeforeSizeChange"));return;}
  setError("");start(async()=>{
   const result=await setMenuItemActive(item.id,!item.active);
   if(!result.ok){setError(t("error"));return;}
   router.refresh();
  });
 }
 function beginAddRow(after:string){if(hasUnsavedChanges||invalidQuantity){setError(t("saveBeforeAddingIngredient"));return;}setAdd("");setAddAfter(after);setNewRowAmount("1");setSearchIngredient("");setError("");}
 function addPicker(){return <div className="flex flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-accent-soft p-3">
  <label className="min-w-[160px] flex-1 text-[13px] font-bold">{t("addRecipeRow")}
   <input autoFocus value={searchIngredient} onChange={e=>{setSearchIngredient(e.target.value);setAdd("");}} placeholder={t("search")} aria-label={t("search")} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px]"/>
   <select className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px]" aria-label={t("addToRecipe")} value={add??""} onChange={e=>{setAdd(e.target.value);setNewRowUnit(ingredients.find(ingredient=>ingredient.id===e.target.value)?.baseUnit??"ml");setNewRowDensity("");}}>
   <option value="">{t("addToRecipe")}</option>{ingredients.filter(i=>selectedItems.some(item=>!item.recipe.some(line=>line.ingredientId===i.id))&&i.name.toLocaleLowerCase().includes(searchIngredient.toLocaleLowerCase())).map(i=><option key={i.id} value={i.id}>{i.name}</option>)}
  </select></label>
  <label className="w-24 text-[13px] font-bold">{t("quantity")}<input type="number" min="0.0001" step="any" inputMode="decimal" value={newRowAmount} onChange={e=>setNewRowAmount(e.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-2 text-[17px]"/></label>
  <label className="min-w-[105px] text-[13px] font-bold">{t("unit")}<select value={newRowUnit} onChange={e=>{const unit=e.target.value as RecipeDisplayUnit;setNewRowUnit(unit);const entry=ingredients.find(i=>i.id===add);if(entry&&requiresDensity(entry.baseUnit,unit))setNewRowDensity(String(suggestedIngredientDensity(entry.name)??""));}} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-2 text-[17px]">{(add?(()=>{
   const base=ingredients.find(ingredient=>ingredient.id===add)?.baseUnit??"ml";
   return base==="each"?["each"] as RecipeDisplayUnit[]:[...new Set([...recipeDisplayUnitsFor(base,conversions[add]??[]),"g","ml","fl_oz","shot","pump"])] as RecipeDisplayUnit[];
  })():[]).map(unit=><option key={unit} value={unit}>{unitLabel(unit)}</option>)}</select></label>
  {add&&requiresDensity(ingredients.find(i=>i.id===add)?.baseUnit??"ml",newRowUnit)&&
   <label className="w-32 text-[13px] font-bold">{t("densityShort")}
    <input type="number" min=".000001" max="5" step="any" inputMode="decimal" value={newRowDensity}
      onChange={e=>setNewRowDensity(e.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-2 text-[17px]"/>
   </label>}
  {add&&needsIngredientConversion(newRowUnit)&&!(conversions[add]??[]).some(c=>c.unit===newRowUnit)&&
   <label className="w-36 text-[13px] font-bold">{t("measureShort",{unit:unitLabel(newRowUnit)})}
    <input type="number" min=".000001" step="any" inputMode="decimal"
      value={calibration[add+":"+newRowUnit]??String(measureDefault(add,ingredients.find(i=>i.id===add)?.name??"",ingredients.find(i=>i.id===add)?.baseUnit??"ml",newRowUnit)??"")}
      onChange={e=>setCalibration(prev=>({...prev,[add+":"+newRowUnit]:e.target.value}))}
      className="mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-2 text-[17px]"/>
   </label>}
  <button type="button" disabled={pending||!add||invalidQuantity||!(Number(newRowAmount)>0)} onClick={append} className="min-h-12 rounded-xl bg-accent px-4 font-bold text-on-accent disabled:opacity-50">{t("add")}</button>
  <button type="button" onClick={()=>setAdd(null)} className="min-h-12 px-3">{t("cancel")}</button></div>;}
 /** Use the one canonical unit-compatibility helper; no parallel conversion rules in the UI. */
 function availableUnits(line:MenuItemForEdit["recipe"][number]):RecipeDisplayUnit[]{
  if(line.baseUnit==="each")return ["each"];
  return [...new Set([...recipeDisplayUnitsFor(line.baseUnit,conversions[line.ingredientId]??[]),"g","ml","fl_oz","shot","pump"])] as RecipeDisplayUnit[];
 }
 function unitLabel(unit:RecipeDisplayUnit){
  return ({shot:units("recipeUnitShot"),pump:units("recipeUnitPump"),g:units("recipeUnitG"),ml:units("recipeUnitMl"),fl_oz:units("recipeUnitFlOz"),each:units("recipeUnitEach")} as Record<RecipeDisplayUnit,string>)[unit];
 }
 function cells(id:string,only?:MenuItemForEdit){return <div className="grid gap-1.5 lg:block" style={mobileColumns}>{(only?[only]:selectedItems).map(item=>{
 const line=item.recipe.find(l=>l.ingredientId===id),draft=drafts[k(item.id,id)];
 if(!line||draft?.removed)return <p key={item.id} className="p-2 text-center text-ink-muted">—</p>;
 const actual=draft??{quantity:line.displayQuantity??line.quantity,unit:(line.displayUnit??line.baseUnit) as RecipeDisplayUnit,removed:false};
 const key=k(item.id,id),cost=prices[item.id]?.lineCosts?.[id]??null;
 const effective=effectiveIngredient(item,line);
 return <div key={item.id} className="min-w-0"><div className="flex min-w-0 gap-1 rounded-xl bg-paper p-1">
  <input type="number" inputMode="decimal" min="0.0001" step="any" aria-label={t("editQuantityForSize",{ingredient:line.ingredientName,size:item.sizeLabel??item.name})}
   value={quantityInputs[key]??String(actual.quantity)} onChange={e=>{
   const text=e.target.value;setQuantityInputs(prev=>({...prev,[key]:text}));const value=Number(text);
   if(text!==""&&Number.isFinite(value)&&value>0){setDrafts(prev=>({...prev,[key]:{quantity:value,unit:actual.unit,removed:false}}));setSaved(false);}
  }} className="min-h-12 min-w-0 w-full rounded-lg border border-line bg-card px-2 text-center text-[17px] font-bold"/>
  <select aria-label={t("unit")} value={actual.unit} onChange={e=>{
   const unit=e.target.value as RecipeDisplayUnit;
   const existing=conversionFor(effective.id);
   const calibrated=existing.find(c=>c.unit===unit)?.baseUnitsPerUnit??null;
   const suggested=needsIngredientConversion(unit)
     ?(calibrated??measureDefault(effective.id,effective.name,line.baseUnit,unit)):null;
   const density=densityFor(item,line,unit,actual.unit);
   const all=unit!==actual.unit&&needsIngredientConversion(unit)&&suggested!==null&&!existing.some(c=>c.unit===unit)
     ?[...existing,{unit,baseUnitsPerUnit:suggested}]:existing;
   const entered=Number(quantityInputs[key]??String(actual.quantity));
   const translated=reexpressRecipeQuantity(actual.unit,unit,entered,line.baseUnit,all,density);
   // Invalid/uncalibrated conversions must not silently reuse the old number.
   const amount=translated===null?0:Number(translated.toFixed(4));
   setDrafts(prev=>({...prev,[key]:{quantity:amount,unit,removed:false}}));
   setQuantityInputs(prev=>({...prev,[key]:translated===null?"":String(amount)}));
   setSaved(false);
   if(needsIngredientConversion(unit)&&!(conversions[effective.id]??[]).some(c=>c.unit===unit)&&suggested!==null)
    setCalibration(prev=>({...prev,[effective.id+":"+unit]:String(suggested)}));
   if(requiresDensity(line.baseUnit,unit)&&densityInputs[key]===undefined&&density!==undefined)
    setDensityInputs(prev=>({...prev,[key]:String(density)}));
   if(translated===null)setError(t("measureNeeded"));else setError("");
  }} className="min-h-12 w-[95px] shrink-0 rounded-lg border border-line bg-card px-1 text-[15px]">{availableUnits(line).map(u=><option key={u} value={u}>{unitLabel(u)}</option>)}</select>
 </div>
  {requiresDensity(line.baseUnit,actual.unit)&&<label className="mt-1 flex flex-wrap items-center gap-1 text-[13px] text-ink-muted">
   <span>{t("densityConversionLabel")}</span><input type="number" step="any" inputMode="decimal" min=".000001" max="5"
     aria-label={t("densityValue",{ingredient:line.ingredientName})}
     value={densityInputs[key]??String(densityFor(item,line,actual.unit)??"")}
     onChange={e=>setDensityInputs(prev=>({...prev,[key]:e.target.value}))}
     className="min-h-12 w-24 rounded-lg border border-line bg-card px-2 text-[17px]"/>
   <span>{t("densityConversionSuffix")} · {t("measureSuggested")}</span>
  </label>}
  {needsIngredientConversion(actual.unit)&&pendingMeasure(effective.id,actual.unit)&&<label className="mt-1 flex flex-wrap items-center gap-1 text-[13px] text-ink-muted">
   <span>{t("measurePerUnit",{unit:unitLabel(actual.unit)})}</span>
   <input type="number" inputMode="decimal" min=".000001" step="any" aria-label={t("measureValue",{unit:unitLabel(actual.unit),ingredient:line.ingredientName})}
    value={calibration[effective.id+":"+actual.unit]??String(measureDefault(effective.id,effective.name,line.baseUnit,actual.unit)??"")}
    onChange={e=>setCalibration(prev=>({...prev,[effective.id+":"+actual.unit]:e.target.value}))}
    className="min-h-12 w-24 rounded-lg border border-line bg-card px-2 text-[17px]"/>
   <span>{line.baseUnit==="g"?units("recipeUnitG"):line.baseUnit==="ml"?units("recipeUnitMl"):units("recipeUnitEach")} · {t("measureSuggested")}</span>
  </label>}
  <p className="mt-1 text-center text-[13px] text-ink-muted">{cost===null?"—":formatCents(cost)}</p></div>;
 })}</div>;}
 return <div className="relative pb-24 text-ink">
 <div className="mb-3 flex flex-wrap items-center gap-2">
  <span className="font-bold">{t("sizesSell")}</span>
  {items.map(item=><button key={item.id} type="button" aria-pressed={focusedSize===item.id} onClick={()=>{if(hasUnsavedChanges||invalidQuantity){setError(t("saveBeforeSizeChange"));return;}setFocusedSize(item.id);onFocusedSizeChange?.(item.id);setAdd(null);setToast("");setError("");}} className={`min-h-12 rounded-full border px-4 font-bold ${focusedSize===item.id?"border-accent bg-accent text-on-accent":"border-line bg-card"}`}>{item.sizeLabel??item.name}{!active.includes(item.id)?" · "+t("priceNotSet"):""}</button>)}
  {draftSizes.map(draft=><button key={draft.id} type="button" onClick={()=>{setPriceDraft(draft.id);setDraftPrice("");}} className="min-h-12 rounded-full border border-dashed border-warn px-4">{draft.sizeLabel??draft.name}</button>)}
  <button type="button" onClick={()=>setSizeDialog(true)} className="min-h-12 rounded-full border border-dashed border-accent px-4 text-accent-text">{t("addSize")}</button>
 </div>
 <button type="button" disabled={pending||!selectedItems[0]} onClick={()=>selectedItems[0]&&toggleSize(selectedItems[0])} className="mb-3 min-h-12 rounded-xl border border-line px-4 text-[17px]">{active.includes(focusedSize)?menu("noLongerServing"):menu("serveAgain")}</button>
 <div className="mb-3 flex flex-wrap gap-2"><button type="button" onClick={()=>beginAddRow("top")} className="min-h-12 rounded-xl border border-line bg-card px-4 font-bold text-accent-text"><Plus className="me-1 inline size-4"/>{t("addRecipeRow")}</button><button type="button" onClick={()=>{if(hasUnsavedChanges||invalidQuantity){setError(t("saveBeforeAddingIngredient"));return;}setNewPantry(v=>!v);}} className="min-h-12 rounded-xl bg-accent px-4 font-bold text-on-accent"><Plus className="me-1 inline size-4"/>{t("addPantryItem")}</button></div>
 {newPantry&&<div className="mb-3"><NewPantryInlineRow onCancel={()=>setNewPantry(false)} onCreated={async created=>{
  if(!selectedItems[0]){router.refresh();return;}
  const result=await saveProductRecipes({productId:selectedItems[0].id,sizes:recipeChanges(created.id,created.baseUnit)});
  if(!result.ok){setError(t("createdWithoutRecipe"));router.refresh();return;}
  setNewPantry(false);setSaved(true);router.refresh();
 }}/></div>}
 {add!==null&&addAfter==="top"&&addPicker()}
 <div className="mb-2 grid gap-1.5 lg:hidden" style={mobileColumns}>{selectedItems.map(item=><div key={item.id} className="rounded-xl bg-paper p-2 text-center font-bold">{item.sizeLabel??item.name}</div>)}</div>
 <div className="space-y-2 lg:hidden">{ingredientRows.map(([id,name])=><div key={id} className="rounded-2xl border border-line bg-card p-3"><div className="mb-2 flex min-h-12 items-center gap-2"><strong className="min-w-0 flex-1 break-words">{name}</strong><button type="button" onClick={()=>beginAddRow(id)} aria-label={t("addRecipeRowAfter",{name})} className="flex min-h-12 min-w-12 items-center justify-center rounded-xl bg-accent-soft text-accent-text"><Plus size={18}/></button><button type="button" onClick={()=>openSwap(id)} className="min-h-12 rounded-xl bg-paper px-2 text-[13px] font-bold text-accent-text"><ArrowLeftRight size={15} className="me-1 inline"/>{t("swap")}</button><button type="button" aria-label={t("remove")} onClick={()=>removeRow(id)} className="flex min-h-12 min-w-12 items-center justify-center rounded-full bg-paper"><X size={17}/></button></div>{editingIngredient===id&&replacementPicker(id)}{cells(id)}{add!==null&&addAfter===id&&<div className="mt-3">{addPicker()}</div>}</div>)}</div>
 <div className="hidden overflow-x-auto rounded-2xl border border-line bg-card lg:block"><table className="w-full table-fixed"><thead><tr className="border-b border-line bg-paper"><th className="w-[28%] p-3 text-start">{t("name")}</th>{selectedItems.map(item=><th key={item.id} className="p-3">{item.sizeLabel??item.name}</th>)}</tr></thead><tbody>{ingredientRows.map(([id,name])=><Fragment key={id}><tr className="border-b border-line"><th className="p-3 text-start"><div className="flex items-center gap-2"><span className="min-w-0 flex-1">{replacements[k(focusedSize,id)]?ingredients.find(i=>i.id===replacements[k(focusedSize,id)])?.name??name:name}</span><button type="button" onClick={()=>beginAddRow(id)} aria-label={t("addRecipeRowAfter",{name})} className="flex min-h-12 min-w-12 items-center justify-center rounded-xl bg-accent-soft text-accent-text"><Plus size={18}/></button></div>{editingIngredient===id&&replacementPicker(id)}<div><button type="button" className="min-h-12 text-sm text-accent-text" onClick={()=>openSwap(id)}>{t("swap")}</button><button type="button" className="ms-2 min-h-12 text-sm text-warn" onClick={()=>removeRow(id)}>{t("remove")}</button></div></th>{selectedItems.map(item=><td key={item.id} className="p-2">{cells(id,item)}</td>)}</tr>{add!==null&&addAfter===id&&<tr><td colSpan={selectedItems.length+1} className="p-2">{addPicker()}</td></tr>}</Fragment>)}</tbody></table></div>
 {error&&<p role="alert" className="mt-2 text-warn">{error}</p>}{saved&&<p role="status" className="mt-2 text-good">{t("saved")}</p>}
 <div className="sticky bottom-24 z-20 mt-6 rounded-2xl border border-line bg-card p-3 shadow-xl"><h2 className="mb-3 font-headline text-xl font-extrabold">{t("whatYouKeep")}</h2><div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:flex lg:flex-col">{selectedItems.map(item=>{const p=prices[item.id];return <div key={item.id} className="min-w-0 rounded-xl bg-paper p-2 text-center text-[13px]"><p className="font-bold">{item.sizeLabel??item.name}</p><p>{t("cost")} {p?.cost===null?"—":formatCents(p.cost)}</p><p>{t("price")} {formatCents(item.priceCents)}</p><p className="font-extrabold text-good">{p?.summary.keepCents===null?"—":t("keep",{amount:formatCents(p.summary.keepCents),percent:p.summary.keepPercent ?? 0})}</p>{p?.estimated&&<p className="text-warn">{t("estimate")}</p>}</div>})}</div><button type="button" onClick={save} disabled={pending||invalidQuantity||invalidDensity||selectedItems.length===0} className="mt-3 min-h-14 w-full rounded-xl bg-accent font-bold text-on-accent disabled:opacity-50">{t("saveItem",{name:items[0]?.baseName??""})}</button></div>
 {toast&&<div role="status" className="fixed bottom-40 start-4 z-30 flex items-center gap-2 rounded-2xl bg-ink px-4 py-3 text-card">{t("removed",{name:toast})} · <button type="button" onClick={undo} className="min-h-10 font-bold underline">{t("undo")}</button></div>}
 {priceDraft&&<div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"><div className="w-full max-w-sm rounded-t-2xl bg-card p-5 text-ink sm:rounded-2xl"><h2 className="mb-3 font-headline text-xl font-bold">{t("setPrice")}</h2><label className="block font-bold">{t("itemPrice")}<input autoFocus type="number" min=".01" step=".01" value={draftPrice} onChange={e=>setDraftPrice(e.target.value)} className="mt-2 min-h-12 w-full rounded-xl border border-line bg-card px-3"/></label><div className="mt-4 flex gap-2"><button type="button" className="min-h-12 flex-1 rounded-xl border border-line" onClick={()=>setPriceDraft(null)}>{t("cancel")}</button><button type="button" disabled={pending||!(Number(draftPrice)>0)} className="min-h-12 flex-1 rounded-xl bg-accent text-on-accent" onClick={saveDraftSizePrice}>{t("save")}</button></div></div></div>}
 {sizeDialog&&items[0]&&<AddSizeDialog baseName={items[0].baseName} category={items[0].category} menuGroup={items[0].menuGroup} siblingSizes={items.map(item=>({id:item.id,name:item.name,sizeLabel:item.sizeLabel,priceCents:item.priceCents}))} onDone={()=>{setSizeDialog(false);router.refresh();}} onClose={()=>setSizeDialog(false)}/>}

 </div>;
}
