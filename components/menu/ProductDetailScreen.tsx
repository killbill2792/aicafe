"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Coffee, FilePenLine, Pencil, Power, TriangleAlert } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { usePathname, useRouter } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import { renameProduct, setMenuItemActive, updateMenuItemPrice } from "@/lib/actions/menuItems";
import type { IngredientOption, MenuItemForEdit } from "@/lib/data/getMenuItemsForEdit";
import { EMPTY_MENU_PRICING_EVIDENCE, type MenuControlItem } from "@/lib/data/getMenuControlCenter";
import type { IngredientUnitConversion } from "@/lib/calc/recipeUnits";
import type { ProductPhoto } from "@/lib/data/getProductPhoto";
import type { MenuDetailTab } from "@/lib/viewmodels/menuDetail";
import { stableSortSizes } from "@/lib/menu/sizeLabel";
import { usePricingStatusChip } from "./usePricingStatusChip";
import ProductPhotoEditor from "./ProductPhotoEditor";
import RecipeMatrix from "./RecipeMatrix";
import { getItemPricingStatus } from "@/lib/viewmodels/menuCatalogViewModel";

type Period="today"|"days7"|"days30";
export default function ProductDetailScreen({item,ingredients,ingredientConversions,siblingSizes,productEditItems,photo,businessId,focusedSizeId,initialTab,initialPriceItemId}:{item:MenuControlItem;ingredients:IngredientOption[];menuGroupOptions:string[];ingredientConversions:Record<string,IngredientUnitConversion[]>;siblingSizes:MenuControlItem[];productEditItems:MenuItemForEdit[];photo:ProductPhoto;businessId:string|null;focusedSizeId?:string;justCreated?:boolean;initialTab:MenuDetailTab;initialPriceItemId?:string;copiedFrom?:string}){
 const t=useTranslations("Menu");const te=useTranslations("ManageMenu");const router=useRouter();const pathname=usePathname();const statusChip=usePricingStatusChip();const all=stableSortSizes([item,...siblingSizes]);const [tab,setTab]=useState(initialTab);const [editingPriceId,setEditingPriceId]=useState<string|null>(all.some(size=>size.id===initialPriceItemId)?initialPriceItemId??null:null);const [renaming,setRenaming]=useState(false);const [name,setName]=useState(item.baseName);const [pending,start]=useTransition();const [error,setError]=useState<string|null>(null);const productActive=all.some(size=>size.active);
 function navigate(next:MenuDetailTab,size?:string){setTab(next);router.replace(`${pathname}?tab=${next}${size?`&size=${encodeURIComponent(size)}`:""}`,{scroll:false});}
 function saveName(){start(async()=>{const r=await renameProduct({menuItemId:item.id,name});if(r.ok){setRenaming(false);router.refresh();}else setError(r.error);});}
 return <>
  <section className="grid gap-5 rounded-card-lg border border-line/60 bg-card p-[18px] shadow-sm md:grid-cols-[280px_1fr]">
   <ProductPhotoEditor menuItemId={item.id} businessId={businessId} photo={photo} labels={{photo:t("addPhoto"),change:t("changePhoto"),remove:t("removePhoto"),error:t("photoError")}}/>
   <div className="flex flex-col justify-center">{item.menuGroup&&<p className="mb-1 text-ink-muted">{item.menuGroup}</p>}{renaming?<div className="flex flex-wrap gap-2"><input className="h-12 min-w-0 flex-1 rounded-lg border border-line px-3 text-xl font-bold" value={name} onChange={e=>setName(e.target.value)}/><button type="button" onClick={saveName} disabled={pending} className="min-h-12 rounded-full bg-ink px-4 font-bold text-paper">{te("saveChanges")}</button><button type="button" onClick={()=>setRenaming(false)} className="min-h-12 px-3 font-bold">{te("cancel")}</button></div>:<div className="flex items-center gap-2"><h1 className="font-headline text-4xl font-bold md:text-5xl">{item.baseName}</h1><button type="button" onClick={()=>setRenaming(true)} aria-label={t("editProductName")} className="flex min-h-12 min-w-12 items-center justify-center rounded-xl border border-line hover:bg-paper"><Pencil size={19}/></button></div>}<p className={`mt-3 flex w-fit items-center gap-2 rounded-full px-3 py-1.5 font-bold ${productActive?"bg-good-tint text-good":"bg-paper text-ink-muted"}`}><span className={`h-2.5 w-2.5 rounded-full ${productActive?"bg-good":"bg-ink-muted"}`}/>{productActive?t("active"):t("inactive")}</p>{error&&<p className="mt-2 text-[17px] text-warn">{error}</p>}</div>
  </section>
  <div className="flex gap-7 overflow-x-auto border-b border-line" role="tablist">{(["overview","recipe"] as const).map(k=><button key={k} type="button" role="tab" aria-selected={tab===k} onClick={()=>navigate(k)} className={`min-h-12 border-b-[3px] px-1 font-bold ${tab===k?"border-ink text-ink":"border-transparent text-ink-muted"}`}>{t(k==="overview"?"tabOverview":"tabRecipe")}</button>)}</div>
  {tab==="overview"&&<><div><h2 className="font-headline text-3xl font-bold">{t("sizes")}</h2><p className="text-ink-muted">{t("sizesHelp")}</p></div><div className="grid gap-4 xl:grid-cols-3">{all.map(size=><SizeCard key={size.id} size={size} t={t} chip={statusChip(size)} editing={editingPriceId===size.id} onPrice={()=>{setEditingPriceId(size.id);router.replace(`${pathname}?tab=overview&editPrice=${encodeURIComponent(size.id)}`,{scroll:false})}} onPriceClose={()=>{setEditingPriceId(null);router.replace(`${pathname}?tab=overview`,{scroll:false})}} saveLabel={te("saveChanges")} cancelLabel={te("cancel")} onRecipe={()=>navigate("recipe",size.id)} onToggle={()=>start(async()=>{const r=await setMenuItemActive(size.id,!size.active);if(r.ok)router.refresh();else setError(r.error)})}/>)}</div></>}
  {tab==="recipe"&&<RecipeMatrix key={productEditItems.flatMap(item=>item.recipe.map(line=>`${item.id}:${line.ingredientId}:${line.displayQuantity??line.quantity}:${line.displayUnit??line.baseUnit}`)).join("|")} items={productEditItems} ingredients={ingredients} ingredientConversions={ingredientConversions} focusedSizeId={focusedSizeId} labels={{ingredient:t("ingredient"),focused:t("focusedSize"),inactive:t("noLongerServing"),noRecipe:t("noRecipe"),missingCost:t("recipeMissingCostReason"),remove:te("remove"),addIngredient:t("addIngredient"),search:te("ingredientSearchLabel"),unit:te("unitLabel"),cancel:te("cancel"),saveRecipe:t("saveRecipe"),saved:t("recipeSaved"),partialSave:t("recipePartialSave"),completeDraft:t("completeRecipeRow"),completePurchaseCost:t("completePurchaseCost"),conversionRequired:t("conversionRequired"),purchaseCost:t("purchaseCost"),purchasePrice:t("purchasePrice"),purchaseQuantity:t("purchaseQuantity"),purchaseUnit:t("purchaseUnit"),existing:te("existingTag"),createNamed:t("createIngredientNamed"),removeDraft:t("removeDraftRow"),undo:t("undo"),notUsed:t("notUsed"),type:t("ingredientType"),g:t("weightShort"),ml:t("volumeShort"),each:t("countShort"),fl_oz:te("recipeUnitFlOz"),shot:te("recipeUnitShot"),pump:te("recipeUnitPump")}}/>}
 </>;
}
function SizeCard({size,t,chip,editing,onPrice,onPriceClose,saveLabel,cancelLabel,onRecipe,onToggle}:{size:MenuControlItem;t:ReturnType<typeof useTranslations<"Menu">>;chip:{label:string;good:boolean};editing:boolean;onPrice:()=>void;onPriceClose:()=>void;saveLabel:string;cancelLabel:string;onRecipe:()=>void;onToggle:()=>void}){
 const format=useFormatter();const [period,setPeriod]=useState<Period>("days30");const ready=size.costStatus==="READY"&&size.ingredientsCostCents!==null;const keep=ready?size.priceCents-size.ingredientsCostCents!:null;const units=size.unitsSoldByPeriod?.[period]??null;const daily=size.unitsSoldDailyByPeriod?.[period]??null;
 return <article className={`overflow-hidden rounded-card-lg border bg-card shadow-sm ${size.active?"border-line":"border-line opacity-80"}`}>
  <div className="p-4"><div className="flex items-center gap-3"><span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[#fbf1e3] text-[#7a3f13]"><Coffee size={27} strokeWidth={2.2}/></span><div><h3 className="text-2xl font-extrabold">{size.sizeLabel??size.name}</h3><p className="text-ink-muted">{size.active?t("active"):t("inactive")}</p></div></div>
   <dl className="mt-4 grid grid-cols-3 divide-x divide-line border-t border-line pt-3 rtl:divide-x-reverse"><div className="pe-2"><dt className="text-sm text-ink-muted">{t("sellingPrice")}</dt><dd className="mt-1"><InlinePrice size={size} editing={editing} onEdit={onPrice} onClose={onPriceClose} saveLabel={saveLabel} cancelLabel={cancelLabel} suggestedLabel={t("suggested")} inputLabel={t("sellingPrice")}/></dd></div><div className="px-2"><dt className="text-sm text-ink-muted">{t("costToMake")}</dt><dd className="mt-1 text-xl font-bold">{ready?formatCents(size.ingredientsCostCents!):"—"}</dd></div><div className="ps-2"><dt className="text-sm text-ink-muted">{t("youKeep")}</dt><dd className="mt-1 text-xl font-extrabold text-good">{keep===null?"—":formatCents(keep)}</dd></div></dl>
   {ready&&keep!==null&&<div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-line" aria-label={t("costKeepSummary",{cost:formatCents(size.ingredientsCostCents!),keep:formatCents(keep)})}><span className="bg-ingredients" style={{flexGrow:size.ingredientsCostCents!,flexBasis:0}}/><span className="bg-good" style={{flexGrow:Math.max(keep,0),flexBasis:0}}/></div>}
   <div className="mt-4 rounded-2xl bg-paper p-3"><div className="flex items-end justify-between gap-3"><div className="min-w-0 flex-1"><p className="text-sm text-ink-muted">{t("unitsSold")}</p><p className="text-2xl font-extrabold">{units===null?t("noSalesData"):format.number(units)}</p></div>{daily&&<SalesBars days={daily}/>}</div><div className="mt-2 grid grid-cols-3 rounded-xl bg-card p-1" aria-label={t("salesPeriod")}>{(["today","days7","days30"] as const).map(value=><button key={value} type="button" aria-pressed={period===value} onClick={()=>setPeriod(value)} className={`min-h-12 rounded-lg px-1 text-sm font-bold ${period===value?"bg-ink text-paper":"text-ink-muted"}`}>{t(value==="today"?"today":value==="days7"?"last7Days":"last30Days")}</button>)}</div></div>
   <div className="mt-3 grid grid-cols-2 gap-2"><StatusBox label={t("priceStatus")} value={chip.label} good={chip.good}/><StatusBox label={t("recipeStatus")} value={ready?t("recipeReady"):t("needsReview")} good={ready}/></div>
   <PriceEvidencePanel size={size} t={t} format={format}/>
   <button type="button" onClick={onRecipe} className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-good px-2 font-bold text-white hover:bg-good/90"><FilePenLine size={18}/>{ready?t("editRecipe"):t("reviewRecipe")}</button>
  </div><button type="button" onClick={onToggle} className={`flex min-h-12 w-full items-center justify-center gap-2 border-t px-3 font-bold ${size.active?"border-warn/20 bg-warn-tint/35 text-warn":"border-good/20 bg-good-tint text-good"}`}><Power size={18}/>{size.active?t("noLongerServing"):t("serveAgain")}</button>
 </article>;
}
function InlinePrice({size,editing,onEdit,onClose,saveLabel,cancelLabel,suggestedLabel,inputLabel}:{size:MenuControlItem;editing:boolean;onEdit:()=>void;onClose:()=>void;saveLabel:string;cancelLabel:string;suggestedLabel:string;inputLabel:string}){
 const router=useRouter();const [value,setValue]=useState((size.priceCents/100).toFixed(2));const [error,setError]=useState<string|null>(null);const [pending,start]=useTransition();const inputRef=useRef<HTMLInputElement>(null);const status=getItemPricingStatus(size);
 useEffect(()=>{if(editing)requestAnimationFrame(()=>{inputRef.current?.scrollIntoView({block:"center",behavior:"smooth"});inputRef.current?.focus();});},[editing]);
 if(!editing)return <button type="button" onClick={()=>{setValue((size.priceCents/100).toFixed(2));setError(null);onEdit();}} className="flex min-h-12 items-center gap-1.5 rounded-lg text-xl font-extrabold hover:text-good"><span>{formatCents(size.priceCents)}</span><Pencil size={17} aria-hidden="true"/></button>;
 const suggested=(status.kind==="low"||status.kind==="high")?status.suggestedPriceCents:null;
 return <div className="min-w-[150px]"><label className="flex h-12 items-center rounded-lg border border-ink bg-card px-2 font-bold"><span aria-hidden="true">$</span><input ref={inputRef} aria-label={inputLabel} inputMode="decimal" value={value} onChange={event=>setValue(event.target.value)} className="w-20 min-w-0 px-1 outline-none"/></label>{suggested!==null&&<p className="mt-1 text-sm font-medium text-ink-muted">{suggestedLabel} {formatCents(suggested)}</p>}{error&&<p className="mt-1 text-sm text-warn" role="alert">{error}</p>}<div className="mt-2 flex gap-1"><button type="button" disabled={pending} onClick={()=>start(async()=>{const cents=Math.round(Number(value)*100);const result=await updateMenuItemPrice({menuItemId:size.id,priceCents:cents});if(result.ok){router.refresh();onClose();}else setError(result.error);})} className="min-h-12 rounded-lg bg-ink px-3 text-sm font-bold text-paper disabled:opacity-40">{saveLabel}</button><button type="button" disabled={pending} onClick={()=>{setError(null);onClose();}} className="min-h-12 rounded-lg px-2 text-sm font-bold">{cancelLabel}</button></div></div>;
}
function PriceEvidencePanel({
 size,
 t,
 format,
}:{
 size:MenuControlItem;
 t:ReturnType<typeof useTranslations<"Menu">>;
 format:ReturnType<typeof useFormatter>;
}){
 const evidence=size.pricingEvidence ?? EMPTY_MENU_PRICING_EVIDENCE;
 const cost=evidence.costBenchmark;
 const sales=evidence.salesResponse;
 const market=evidence.nearbyMarket;
 const pct=(value:number)=>`${format.number(Math.abs(value),{maximumFractionDigits:1})}%`;
 const units=(value:number)=>format.number(value,{maximumFractionDigits:1});
 const changeDate=(date:string)=>format.dateTime(new Date(`${date}T12:00:00Z`),{month:"short",day:"numeric",year:"numeric"});
 const provider=(value:string|null)=>value?value.charAt(0).toUpperCase()+value.slice(1):"POS";
 const source=sales.status==="no_change_history"
   ? null
   : sales.change.sourceType==="owner_manual"
     ? t("priceSourceOwner")
     : sales.change.sourceType==="connected_pos"
       ? t("priceSourcePos",{provider:provider(sales.change.sourceProvider)})
       : t("priceSourceImported");
 const costText=cost.status==="unavailable"
   ? t("costBenchmarkUnavailable")
   : cost.position==="above"
     ? t("costBenchmarkAbove",{amount:formatCents(Math.abs(cost.differenceCents)),benchmark:formatCents(cost.benchmarkPriceCents),percent:pct(cost.differencePercent)})
     : cost.position==="below"
       ? t("costBenchmarkBelow",{amount:formatCents(Math.abs(cost.differenceCents)),benchmark:formatCents(cost.benchmarkPriceCents),percent:pct(cost.differencePercent)})
       : t("costBenchmarkNear",{benchmark:formatCents(cost.benchmarkPriceCents)});
 let salesText:string;
 let salesDetail:string|null=null;
 if(sales.status==="no_change_history"){
   salesText=t("salesResponseNoHistory");
 }else{
   const changed=sales.priceChangeCents>0
     ? t("priceChangedUp",{amount:formatCents(Math.abs(sales.priceChangeCents)),date:changeDate(sales.change.changedOn)})
     : t("priceChangedDown",{amount:formatCents(Math.abs(sales.priceChangeCents)),date:changeDate(sales.change.changedOn)});
   if(sales.status==="not_enough_data"){
     salesText=changed;
     salesDetail=t("salesResponseNotEnough",{before:sales.beforeCoveredDays,after:sales.afterCoveredDays,minimum:sales.minimumCoveredDays});
   }else{
     const unitKey=sales.unitsDirection==="up"?"salesUnitsUp":sales.unitsDirection==="down"?"salesUnitsDown":"salesUnitsFlat";
     const revenueKey=sales.revenueDirection==="up"?"salesRevenueUp":sales.revenueDirection==="down"?"salesRevenueDown":"salesRevenueFlat";
     salesText=changed;
     salesDetail=`${t(unitKey,{percent:pct(sales.unitsPerDayChangePercent),before:units(sales.beforeUnitsPerDay),after:units(sales.afterUnitsPerDay)})} ${t(revenueKey,{percent:pct(sales.revenuePerDayChangePercent),before:formatCents(sales.beforeRevenuePerDayCents),after:formatCents(sales.afterRevenuePerDayCents)})}`;
   }
 }
 const marketText=market.status==="unavailable"
   ? t("marketUnavailable",{count:market.verifiedNearbyCount,minimum:market.minimumCompetitors})
   : market.position==="above"
     ? t("marketAbove",{percent:pct(market.differencePercent),count:market.verifiedNearbyCount,median:formatCents(market.medianPriceCents)})
     : market.position==="below"
       ? t("marketBelow",{percent:pct(market.differencePercent),count:market.verifiedNearbyCount,median:formatCents(market.medianPriceCents)})
       : t("marketNear",{count:market.verifiedNearbyCount,median:formatCents(market.medianPriceCents)});
 return <section className="mt-3 rounded-2xl border border-line bg-[#FBF7F1] p-4">
   <h4 className="text-lg font-extrabold text-ink">{t("priceAnalysisTitle")}</h4>
   <div className="mt-3 space-y-3">
     <div><p className="font-bold text-ink">{t("costBenchmarkTitle")}</p><p className="mt-1 text-[17px] leading-snug text-ink-muted">{costText}</p><p className="mt-1 text-sm text-ink-muted">{t("costBenchmarkNotMarket")}</p></div>
     <div className="border-t border-line pt-3"><div className="flex flex-wrap items-center gap-2"><p className="font-bold text-ink">{t("salesResponseTitle")}</p>{source&&<span className="rounded-full bg-card px-2 py-1 text-xs font-bold text-ink-muted">{source}</span>}</div><p className="mt-1 text-[17px] leading-snug text-ink-muted">{salesText}</p>{salesDetail&&<p className="mt-1 text-[17px] leading-snug text-ink">{salesDetail}</p>}{sales.status==="ready"&&<p className="mt-1 text-sm text-ink-muted">{t("salesResponseCaveat")}</p>}</div>
     <div className="border-t border-line pt-3"><p className="font-bold text-ink">{t("marketComparisonTitle")}</p><p className="mt-1 text-[17px] leading-snug text-ink-muted">{marketText}</p></div>
   </div>
 </section>;
}
function SalesBars({days}:{days:{date:string;quantity:number}[]}){const peak=Math.max(...days.map(day=>day.quantity),1);return <div className="flex h-14 w-28 items-end justify-end gap-px border-b border-line" aria-hidden="true">{days.map(day=><span key={day.date} className="min-w-[2px] flex-1 rounded-t-sm bg-good/75" style={{height:day.quantity?`${Math.max((day.quantity/peak)*100,4)}%`:0}}/>)}</div>}
function StatusBox({label,value,good}:{label:string;value:string;good:boolean}){return <div className={`rounded-xl p-3 ${good?"bg-good-tint":"bg-amber-50"}`}><p className="text-sm text-ink-muted">{label}</p><p className={`mt-1 flex items-start gap-1.5 font-bold ${good?"text-good":"text-warn"}`}>{good?<Check className="mt-0.5 shrink-0" size={17}/>:<TriangleAlert className="mt-0.5 shrink-0" size={17}/>}<span>{value}</span></p></div>}
