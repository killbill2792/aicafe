"use client";
import {useLocale,useTranslations} from "next-intl";
import {statusSchema} from "@/lib/pos/toast/statusSchema";
import type {z} from "zod";
/** Display the dashboard's canonical status snapshot; do not fetch historical diagnostics twice. */
export default function ToastOnboardingChecklist({status}:{businessId:string;status?:z.infer<typeof statusSchema>|null}){
 const t=useTranslations("ToastConnect"),locale=useLocale();
 const connected=status?.connection==="connected";
 const completed=[connected,connected,status?.connection!==undefined&&status.connection!=="not_connected",connected,connected,
  Boolean(status?.startDate),status?.firstImportCheck==="answered",status?.analytics.verified];
 return <details open className="rounded-card-lg bg-card p-5 text-[17px]" dir={locale==="ar"?"rtl":"ltr"}>
  <summary className="min-h-12 cursor-pointer py-3 text-xl font-bold">{t("checklistTitle")}</summary>
  <ol className="flex flex-col gap-3">{completed.map((done,i)=><li key={i} className="flex gap-3">
   <span aria-hidden="true">{status==null?"…":done?"✓":"○"}</span><p><span className="sr-only">{status==null?t("pending"):t(done?"checklistDone":"checklistPending")}</span>{t("checklist"+(i+1))}</p>
  </li>)}</ol>
  <p className="mt-3 text-muted">{t("checklistScopes")}</p>
 </details>;
}
