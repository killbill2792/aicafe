"use client";
import {useEffect,useState} from "react";
import {useLocale,useTranslations} from "next-intl";
import {statusSchema} from "@/lib/pos/toast/statusSchema";
import type {z} from "zod";
import {subscribeToastConnectionChanges} from "./toastConnectionEvents";
export default function ToastOnboardingChecklist({businessId}:{businessId:string}){
 const t=useTranslations("ToastConnect"),locale=useLocale();
 const [status,setStatus]=useState<z.infer<typeof statusSchema>|null>(null);
 useEffect(()=>{let cancelled=false;
  const refresh=()=>{void fetch("/api/pos/toast/status?businessId="+encodeURIComponent(businessId),{cache:"no-store"})
   .then(r=>r.ok?r.json():null).then(data=>{const p=statusSchema.safeParse(data);if(!cancelled&&p.success)setStatus(p.data);}).catch(()=>{});};
  refresh();const unsubscribe=subscribeToastConnectionChanges(window,refresh);
  return()=>{cancelled=true;unsubscribe();};
 },[businessId]);
 const connected=status?.connection==="connected";
 const completed=[connected,connected,status?.connection!==undefined&&status.connection!=="not_connected",connected,connected,
  Boolean(status?.startDate),status?.firstImportCheck==="answered",status?.analytics.verified];
 return <details open className="rounded-card-lg bg-card p-5 text-[17px]" dir={locale==="ar"?"rtl":"ltr"}>
  <summary className="min-h-12 cursor-pointer py-3 text-xl font-bold">{t("checklistTitle")}</summary>
  <ol className="flex flex-col gap-3">{completed.map((done,i)=><li key={i} className="flex gap-3">
   <span aria-hidden="true">{done?"✓":"○"}</span><p><span className="sr-only">{t(done?"checklistDone":"checklistPending")}</span>{t("checklist"+(i+1))}</p>
  </li>)}</ol>
  <p className="mt-3 text-muted">{t("checklistScopes")}</p>
 </details>;
}
