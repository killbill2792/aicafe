"use client";
import {useMemo,useState,useTransition} from "react";
import {Link,useRouter} from "@/i18n/navigation";
import {detectCsvColumns} from "@/lib/pos/csv/csvUtils";
import {readUploadedFileAsCsvText,UPLOAD_FILE_ACCEPT} from "@/lib/pos/csv/readUploadedFile";
import {saveBulkPurchases,editInventoryPurchase,voidInventoryPurchase,importInventoryCsv,type PurchaseCsvMapping}
 from "@/lib/actions/inventory";
import type {PurchaseMonthLine} from "@/lib/data/inventory.server";
import type {PurchaseLineInput} from "@/lib/inventory/recordPurchases.server";
import {parseOwnerPurchaseNumbers} from "@/lib/calc/ownerPurchaseNumbers";

type Item={id:string;name:string;baseUnit:"g"|"ml"|"each";archivedAt?:string|null};
type Draft=Omit<PurchaseLineInput,"quantity"|"costCents">&{quantity:string;cost:string};
function emptyLine(items:Item[],date:string):Draft{
 return {lineId:crypto.randomUUID(),ingredientId:items[0]?.id??null,date,quantity:"1",
  unit:items[0]?.baseUnit??"each",cost:""};
}
const commonUnits:Record<Item["baseUnit"],string[]>={
 ml:["ml","fl_oz","l","qt","gal","pump"],g:["g","kg","lb","oz_wt","shot"],
 each:["each","dozen","case(100)","case(1000)"]
};
const columns=["date","item","quantity","unit","cost"] as const;
export default function InventoryPurchasePanel({items,month,rows,currency,locale,t,today,unavailable}:{
 items:Item[];month:string;rows:PurchaseMonthLine[];currency:string;locale:"en"|"es"|"ar";
 t:Record<string,string>;today:string;unavailable:boolean;
}){
 const router=useRouter(),[pending,start]=useTransition();
 const activeItems=items.filter(i=>!i.archivedAt);
 const [drafts,setDrafts]=useState<Draft[]>(()=>[emptyLine(items.filter(i=>!i.archivedAt),today)]);
 const [errors,setErrors]=useState<Record<string,string>>({});
 const [editing,setEditing]=useState<string|null>(null),[editDraft,setEditDraft]=useState<Draft|null>(null);
 const [fileText,setFileText]=useState<string|null>(null),[fileHeaders,setFileHeaders]=useState<string[]>([]);
 const [mapping,setMapping]=useState<PurchaseCsvMapping>({date:"",item:"",quantity:"",unit:"",cost:""});
 const [csvStatus,setCsvStatus]=useState("");
 const qty=(value:number)=>new Intl.NumberFormat(locale,{maximumFractionDigits:4}).format(value);
 const money=(cents:number|null)=>cents===null?t.unknown:
  new Intl.NumberFormat(locale,{style:"currency",currency}).format(cents/100);
 const parseDraft=(d:Draft):{line:PurchaseLineInput|null;error:string|null}=>{
  const parsed=parseOwnerPurchaseNumbers({quantity:d.quantity,cost:d.cost},locale);
  if(!parsed.numbers)return {line:null,error:parsed.error};
  return {line:{lineId:d.lineId,ingredientId:d.ingredientId,date:d.date,
   quantity:parsed.numbers.quantity,unit:d.unit,costCents:parsed.numbers.costCents,
   expectedRevision:d.expectedRevision},error:null};
 };
 const update=(id:string,patch:Partial<Draft>)=>setDrafts(prev=>prev.map(d=>d.lineId===id?{...d,...patch}:d));
 const totals=useMemo(()=>{
  const byId=new Map<string,{name:string;total:number;unit:string;cost:number|null}>();
  for(const r of rows.filter(r=>!r.voided)){
   const v=byId.get(r.ingredientId)??{name:r.ingredientName,total:0,unit:r.baseUnit,cost:0};
   v.total+=r.baseQuantity;
   v.cost=v.cost===null||r.costCents===null?null:v.cost+r.costCents;
   byId.set(r.ingredientId,v);
  }
  return [...byId.values()].sort((a,b)=>a.name.localeCompare(b.name));
 },[rows]);
 const sourceLabel=(source:string)=>t["source_"+source]??t.source_other;
 const submit=()=>{
  start(async()=>{
   try{
   const prepared=drafts.map(d=>({draft:d,...parseDraft(d)}));
   const valid=prepared.flatMap(x=>x.line?[x.line]:[]);
   const result=valid.length?await saveBulkPurchases(valid):[];
   const bad=prepared.filter(x=>x.error).map(x=>({lineId:x.draft.lineId,ok:false,error:x.error??"save_failed"}));
   result.push(...bad);
   const byId=new Map(result.map(r=>[r.lineId,r]));
   setErrors(Object.fromEntries(result.filter(r=>!r.ok).map(r=>[r.lineId,r.error??"save_failed"])));
   setDrafts(prev=>{
    const keep=prev.filter(r=>byId.get(r.lineId)?.ok!==true);
    return keep.length?keep:[emptyLine(activeItems,today)];
   });
   if(result.some(r=>r.ok))router.refresh();
   }catch{setErrors(Object.fromEntries(drafts.map(line=>[line.lineId,"save_failed"])));}
  });
 };
 const beginEdit=(r:PurchaseMonthLine)=>{
  setEditing(r.lineId);
  setEditDraft({lineId:r.lineId,ingredientId:r.ingredientId,date:r.date,
    quantity:String(r.quantity),unit:r.unit,cost:r.costCents===null?"":String(r.costCents/100),expectedRevision:r.revision});
 };
 const saveEdit=()=>{
  if(!editDraft)return;
  start(async()=>{
   try{
   const parsed=parseDraft(editDraft);
   if(!parsed.line){setErrors(prev=>({...prev,[editDraft.lineId]:parsed.error??"save_failed"}));return;}
   const result=await editInventoryPurchase(parsed.line);
   if(result.ok){setEditing(null);setEditDraft(null);router.refresh();}
   else setErrors(prev=>({...prev,[editDraft.lineId]:result.error??"save_failed"}));
   }catch{setErrors(prev=>({...prev,[editDraft.lineId]:"save_failed"}));}
  });
 };
 const voidLine=(id:string)=>{
  start(async()=>{
   try{
   const result=await voidInventoryPurchase(id);
   if(result.ok)router.refresh();
   else setErrors(prev=>({...prev,[id]:result.error??"save_failed"}));
   }catch{setErrors(prev=>({...prev,[id]:"save_failed"}));}
  });
 };
 const chooseFile=async(file:File|null)=>{
  if(!file)return;
  try{
   const content=await readUploadedFileAsCsvText(file);
   if(content.length>2_000_000)throw Error("too_large");
   const parsed=detectCsvColumns(content),headers=parsed.headers;
   setFileText(content);setFileHeaders(headers);setCsvStatus("");
   const match=(patterns:string[])=>headers.find(h=>patterns.some(p=>h.toLowerCase().includes(p)))??"";
   setMapping({date:match(["date","fecha","تاريخ"]),item:match(["item","ingredient","product","artículo","ingred","صنف"]),
    quantity:match(["quantity","qty","cantidad","كمية"]),unit:match(["unit","unidad","وحدة"]),cost:match(["cost","total","amount","costo","تكلفة"])});
  }catch{setCsvStatus(t.csvFailed);}
 };
 const submitCsv=()=>{
  if(!fileText)return;
  start(async()=>{
   try{
   const outcomes=await importInventoryCsv(fileText,mapping,locale);
   const success=outcomes.filter(r=>r.ok).length;
   const failed=outcomes.filter(r=>!r.ok);
   setCsvStatus(failed.length?
     t.csvPartial.replace("{saved}",qty(success)).replace("{failed}",qty(failed.length)):
     t.csvSaved.replace("{saved}",qty(success)));
   if(success)router.refresh();
   }catch{setCsvStatus(t.csvFailed);}
  });
 };
 const input="mt-1 min-h-12 w-full min-w-0 rounded-xl border border-line bg-surface px-3 text-[17px]";
 const button="min-h-12 rounded-xl border border-line px-4 text-[17px] font-semibold disabled:opacity-50";
 const fields=(d:Draft,onChange:(patch:Partial<Draft>)=>void,editingOld=false)=>{
  const choices=editingOld?items:activeItems;
  return <div className="grid gap-2 sm:grid-cols-5">
  <label className="text-[17px]">{t.item}<select value={d.ingredientId??""} className={input}
    onChange={e=>{const i=choices.find(x=>x.id===e.target.value);onChange({ingredientId:e.target.value,unit:i?.baseUnit??"each"});}}>
    {choices.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
  <label className="text-[17px]">{t.quantity}<input className={input} type="text" inputMode="decimal" value={d.quantity}
    onChange={e=>onChange({quantity:e.target.value})}/></label>
  <label className="text-[17px]">{t.unit}<select className={input} value={d.unit}
    onChange={e=>onChange({unit:e.target.value})}>
    {[...new Set([...commonUnits[items.find(i=>i.id===d.ingredientId)?.baseUnit??"each"],d.unit])].map(u=><option key={u}>{u}</option>)}</select></label>
  <label className="text-[17px]">{t.cost}<input className={input} type="text" inputMode="decimal"
    placeholder={t.optional} value={d.cost}
    onChange={e=>onChange({cost:e.target.value})}/></label>
  <label className="text-[17px]">{t.date}<input className={input} type="date" value={d.date}
    onChange={e=>onChange({date:e.target.value})}/></label>
 </div>;
 };
 return <section dir={locale==="ar"?"rtl":"ltr"} className="mb-5 space-y-4 rounded-2xl border border-line bg-surface p-4 text-ink">
  <h2 className="text-xl font-bold">{t.heading}</h2>
  <div className="flex flex-wrap items-end gap-3">
   <label className="text-[17px]">{t.month}<input type="month" value={month} className={input}
     onChange={e=>router.push("/menu/pantry?month="+encodeURIComponent(e.target.value))}/></label>
   <Link href="/add-cost/receipt" className={button+" inline-flex items-center bg-accent text-on-accent"}>{t.photo}</Link>
  </div>
  {unavailable&&<p role="alert" className="text-[17px] text-neg">{t.unavailable}</p>}
  {!unavailable&&<div className="space-y-2">
   {rows.filter(r=>!r.voided).length===0&&<p className="text-[17px] text-muted">{t.empty}</p>}
   {rows.filter(r=>!r.voided).map(r=><div key={r.lineId} className="rounded-xl border border-line p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
     <div><p className="text-[17px] font-bold">{r.ingredientName}</p>
      <p className="text-[17px] text-muted">{r.date} · {qty(r.quantity)+" "+r.unit+" · "+qty(r.baseQuantity)+" "+r.baseUnit}</p>
      <span className="text-[17px] text-muted">{sourceLabel(r.source)}</span></div>
     <p className="text-[17px] font-semibold">{money(r.costCents)}</p>
    </div>
    {editing===r.lineId&&editDraft?<div className="mt-3 space-y-2">
      {fields(editDraft,patch=>setEditDraft(v=>v?{...v,...patch}:v),true)}
      <button type="button" disabled={pending} className={button+" bg-accent text-on-accent"} onClick={saveEdit}>{t.save}</button>
      <button type="button" className={button} onClick={()=>setEditing(null)}>{t.cancel}</button>
     </div>:<div className="mt-2 flex gap-2">
      <button type="button" disabled={pending} className={button} onClick={()=>beginEdit(r)}>{t.edit}</button>
      <button type="button" disabled={pending} className={button} onClick={()=>voidLine(r.lineId)}>{t.void}</button>
     </div>}
    {errors[r.lineId]&&<p role="alert" className="text-[17px] text-neg">{errors[r.lineId]==="invalid_cost"?t.invalidCost:errors[r.lineId]==="invalid_quantity"?t.invalidQuantity:t.failed}</p>}
   </div>)}
   {!!totals.length&&<div className="rounded-xl bg-surface2 p-3">
    <h3 className="mb-2 text-[17px] font-bold">{t.totals}</h3>
    {totals.map(v=><p key={v.name} className="flex flex-wrap justify-between gap-2 text-[17px]">
     <span>{v.name+" · "+qty(v.total)+" "+v.unit}</span><strong>{money(v.cost)}</strong></p>)}
   </div>}
  </div>}
  <div className="space-y-3 border-t border-line pt-3">
   <h3 className="text-lg font-bold">{t.bulk}</h3>
   {drafts.map(d=><div key={d.lineId} className="rounded-xl border border-line p-3">
    {fields(d,patch=>update(d.lineId,patch))}
    {errors[d.lineId]&&<p role="alert" className="text-[17px] text-neg">{errors[d.lineId]==="invalid_cost"?t.invalidCost:errors[d.lineId]==="invalid_quantity"?t.invalidQuantity:t.failed}</p>}
    <button type="button" className={button+" mt-2"} onClick={()=>setDrafts(v=>v.filter(x=>x.lineId!==d.lineId))}>{t.remove}</button>
   </div>)}
   <div className="flex flex-wrap gap-2">
    <button type="button" className={button} onClick={()=>setDrafts(v=>[...v,emptyLine(activeItems,today)])}>{t.addLine}</button>
    <button type="button" disabled={pending||!drafts.length||!activeItems.length} className={button+" bg-accent text-on-accent"}
     onClick={submit}>{t.saveAll}</button>
   </div>
  </div>
  <div className="space-y-3 border-t border-line pt-3">
   <h3 className="text-lg font-bold">{t.csv}</h3>
   <label className="block text-[17px]">{t.chooseFile}<input type="file" accept={UPLOAD_FILE_ACCEPT}
    className="mt-2 block min-h-12 w-full text-[17px]" onChange={e=>void chooseFile(e.target.files?.[0]??null)}/></label>
   {fileText&&<div className="grid gap-2 sm:grid-cols-2">{columns.map(k=><label key={k} className="text-[17px]">{t[k]}
    <select className={input} value={mapping[k]??""} onChange={e=>setMapping(v=>({...v,[k]:e.target.value}))}>
     <option value="">{t.none}</option>{fileHeaders.map(h=><option key={h} value={h}>{h}</option>)}</select>
    </label>)}</div>}
   {fileText&&<button type="button" className={button+" bg-accent text-on-accent"} disabled={pending||
    !mapping.date||!mapping.item||!mapping.quantity||!mapping.unit} onClick={submitCsv}>{t.import}</button>}
   {csvStatus&&<p role="status" className="text-[17px]">{csvStatus}</p>}
  </div>
 </section>;
}
