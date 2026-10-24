"use client";
import {useEffect,useState} from "react";
import {approvedToastLink} from "./ownerMapping";
import {Link} from "@/i18n/navigation";
import {useLocale} from "next-intl";
type Roster={employee_guid:string;display_name:string;deleted:boolean;linked_employee_id:string|null};
type Catalog={kind:"item"|"modifier";provider_guid:string;name:string;category:string|null;
 price_cents:number|null;linked_menu_item_id:string|null;linked_modifier_recipe_id:string|null};
type Attendance={external_time_entry_id:string;reconciliation_status:string;wage_status:string};
type Employee={id:string;display_name:string;role:string|null;active:boolean};
type Product={id:string;name:string;size_label:string|null;price_cents:number|null;is_active:boolean};
type Modifier={id:string;name:string};
type Review={roster:Roster[];catalog:Catalog[];attendance:Attendance[];
 canonicalEmployees:Employee[];canonicalItems:Product[];canonicalModifiers:Modifier[];
 mappingRequiresExplicitConfirmation:boolean;ownerCorrectionsPreserved:boolean};
export type ToastReviewLabels={
 title:string;sourceRoster:string;sourceMenu:string;refreshStaff:string;refreshMenu:string;
 ownerEmployee:string;ownerProduct:string;ownerModifier:string;unmatched:string;
 mapped:string;approval:string;mappingWarning:string;approve:string;archived:string;
 missingWage:string;attendanceReview:string;noRecords:string;emptyChoice:string;
 unknownPrice:string;priceCents:string;unverified:string;pending:string;error:string;
 success:string;disabled:string;matchNames:string
};
/** No guesses: sources are displayed beside real owner-managed canonical candidates.
 * No source price, wage or name is ever written to their canonical records here. */
export default function ToastOperationalReview({
 businessId,restaurantGuid,enabled,labels
}:{businessId:string;restaurantGuid:string;enabled:boolean;labels:ToastReviewLabels}){
 const locale=useLocale();
 const [review,setReview]=useState<Review|null>(null);
 const [chosen,setChosen]=useState<Record<string,string>>({});
 const [working,setWorking]=useState(false),[error,setError]=useState("");
 const [notice,setNotice]=useState("");
 useEffect(()=>{
  let cancelled=false;
  if(!restaurantGuid)return;
  fetch("/api/pos/toast/pilot/operational?businessId="+encodeURIComponent(businessId)+
   "&restaurantGuid="+encodeURIComponent(restaurantGuid),{cache:"no-store"})
  .then(async response=>{
   if(!response.ok)throw new Error("unavailable");
   const data=await response.json() as Review;
   if(!cancelled)setReview(data);
  }).catch(()=>{if(!cancelled)setError(labels.error);});
  return ()=>{cancelled=true;};
 },[businessId,restaurantGuid,labels.error]);
 async function reload(){
  const response=await fetch("/api/pos/toast/pilot/operational?businessId="+encodeURIComponent(businessId)+
   "&restaurantGuid="+encodeURIComponent(restaurantGuid),{cache:"no-store"});
  if(!response.ok)throw new Error("unavailable");
  setReview(await response.json() as Review);
 }
 async function submit(payload:unknown,linkKey?:string){
  if(working||!enabled)return;
  setWorking(true);setError("");setNotice("");
  try{
   const response=await fetch("/api/pos/toast/pilot/operational",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)
   });
   if(!response.ok)throw new Error("unavailable");
   await reload();
   if(linkKey)setChosen(old=>({...old,[linkKey]:""}));
   setNotice(labels.success);
  }catch{setError(labels.error);}
  finally{setWorking(false);}
 }
 function approve(
  source:{kind:"employee"|"item"|"modifier";guid:string;name:string},
  canonical:{id:string;name:string},key:string
 ){
  if(working||!enabled)return;
  if(!window.confirm(labels.mappingWarning+"\n"+source.name+" → "+canonical.name))return;
  try{
   const payload=approvedToastLink({businessId,restaurantGuid},source,canonical.id,true);
   void submit(payload,key);
  }catch{setError(labels.error);}
 }
 function candidates(kind:"employee"|"item"|"modifier"):{
  id:string;name:string;description:string
 }[]{
  if(!review)return [];
  if(kind==="employee")return review.canonicalEmployees.filter(r=>r.active).map(r=>({
   id:r.id,name:r.display_name,description:r.role??""
  }));
  if(kind==="item")return review.canonicalItems.filter(r=>r.is_active).map(r=>({
   id:r.id,name:r.name,description:r.price_cents==null?labels.unknownPrice:
    labels.priceCents+": "+new Intl.NumberFormat(locale).format(r.price_cents)
  }));
  return review.canonicalModifiers.map(r=>({id:r.id,name:r.name,description:""}));
 }
 function mappingRow(source:{
  kind:"employee"|"item"|"modifier";guid:string;name:string;description:string;
  linkedId:string|null;archived:boolean
 }){
  const key=source.kind+":"+source.guid,choices=candidates(source.kind);
  const choice=choices.find(c=>c.id===chosen[key]);
  return <div key={key} className="flex flex-col gap-2 rounded-xl border border-line p-3">
   <div className="text-sm font-semibold text-ink">{source.name}
    {source.archived&&<span className="ms-2 text-ink-muted">({labels.archived})</span>}
   </div>
   {source.description&&<p className="text-xs text-ink-muted">{source.description}</p>}
   {source.linkedId?<p className="text-sm text-ink-muted">{labels.mapped}: {
    choices.find(c=>c.id===source.linkedId)?.name??source.linkedId
   }</p>:<>
    <label className="flex flex-col gap-1 text-sm text-ink">
     {source.kind==="employee"?labels.ownerEmployee:
       source.kind==="item"?labels.ownerProduct:labels.ownerModifier}
     <select value={chosen[key]??""} disabled={!enabled||working||source.archived}
      onChange={e=>setChosen(old=>({...old,[key]:e.target.value}))}
      className="min-h-11 rounded-xl border border-line bg-surface p-2">
      <option value="">{labels.emptyChoice}</option>
      {choices.map(c=><option key={c.id} value={c.id}>{c.name}{c.description?" — "+c.description:""}</option>)}
     </select>
    </label>
    <button type="button" disabled={!enabled||working||!choice||source.archived}
     onClick={()=>choice&&approve(source,choice,key)}
     className="min-h-11 rounded-full border border-line p-2 text-sm font-semibold disabled:opacity-40">
     {labels.approve}
    </button>
   </>}
  </div>;
 }
 if(!restaurantGuid)return null;
 return <section className="flex flex-col gap-3 rounded-card-lg bg-card p-4">
  <h2 className="text-lg font-bold text-ink">{labels.title}</h2>
  <p className="text-sm text-ink-muted">{labels.mappingWarning}</p>
  <p className="text-sm text-ink-muted">{labels.unverified}</p>
  {enabled&&<Link href="/menu/import-review"
   className="inline-flex min-h-12 items-center justify-center rounded-full bg-accent px-5 font-semibold text-on-accent">
   {labels.matchNames}</Link>}
  {!enabled&&<p role="status" className="text-sm text-warn">{labels.disabled}</p>}
  {enabled&&<div className="flex flex-wrap gap-2">
   <button type="button" disabled={working}
    onClick={()=>void submit({businessId,restaurantGuid,action:"stage_roster"})}
    className="min-h-11 rounded-full border border-line p-3 text-sm disabled:opacity-40">
     {labels.refreshStaff}
   </button>
   <button type="button" disabled={working}
    onClick={()=>void submit({businessId,restaurantGuid,action:"stage_catalog"})}
    className="min-h-11 rounded-full border border-line p-3 text-sm disabled:opacity-40">
     {labels.refreshMenu}
   </button>
  </div>}
  {!review&&!error&&<p role="status" className="text-sm text-ink-muted">{labels.pending}</p>}
  {review&&<>
   <h3 className="text-base font-bold text-ink">{labels.sourceRoster} ({review.roster.length})</h3>
   {review.roster.length?review.roster.map(r=>mappingRow({
    kind:"employee",guid:r.employee_guid,name:r.display_name,
    description:labels.unmatched,linkedId:r.linked_employee_id,archived:r.deleted
   })):<p className="text-sm text-ink-muted">{labels.noRecords}</p>}
   <h3 className="text-base font-bold text-ink">{labels.sourceMenu} ({review.catalog.length})</h3>
   {review.catalog.length?review.catalog.map(r=>mappingRow({
    kind:r.kind,guid:r.provider_guid,name:r.name,
    description:(r.category??"")+(r.price_cents==null?
      " • "+labels.unknownPrice:" • "+labels.priceCents+": "+String(r.price_cents)),
    linkedId:r.kind==="item"?r.linked_menu_item_id:r.linked_modifier_recipe_id,
    archived:false
   })):<p className="text-sm text-ink-muted">{labels.noRecords}</p>}
   <h3 className="text-base font-bold text-ink">{labels.attendanceReview}</h3>
   <p className="text-sm text-ink-muted">{labels.missingWage}: {
    review.attendance.filter(r=>r.wage_status==="missing").length
   }</p>
   <p className="text-sm text-ink-muted">{labels.attendanceReview}: {
    review.attendance.filter(r=>r.reconciliation_status!=="matched").length
   }</p>
  </>}
  {working&&<p role="status" className="text-sm">{labels.pending}</p>}
  {notice&&<p role="status" className="text-sm">{notice}</p>}
  {error&&<p role="alert" className="text-sm text-warn">{error}</p>}
 </section>;
}
