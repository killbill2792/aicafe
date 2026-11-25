"use client";
import {useCallback,useEffect,useState} from "react";
import {useTranslations} from "next-intl";

type Subscription={id:string;enabled:boolean;webhookUrl:string|null;secretStored:boolean;eventKind:string};
const endpoint="/api/pos/toast/webhook/subscriptions";
export default function ToastWebhookSetup({businessId}:{businessId:string}){
 const t=useTranslations("ToastConnect");
 const [kind,setKind]=useState("orders");
 const [rows,setRows]=useState<Subscription[]>([]);
 const [ready,setReady]=useState(false),[busy,setBusy]=useState(false);
 const [selected,setSelected]=useState(""),[secret,setSecret]=useState(""),[message,setMessage]=useState("");
 const load=useCallback(async()=>{
  const res=await fetch(endpoint+"?businessId="+encodeURIComponent(businessId),{cache:"no-store"});
  if(!res.ok)throw Error("unavailable");
  const data=await res.json() as {subscriptions:Subscription[];receiverGloballyEnabled:boolean};
  setRows(data.subscriptions);setReady(data.receiverGloballyEnabled);
  setSelected(old=>data.subscriptions.some(row=>row.id===old)?old:data.subscriptions[0]?.id??"");
 },[businessId]);
 useEffect(()=>{let active=true;void Promise.resolve().then(()=>active?load():undefined).catch(()=>{if(active)setMessage(t("ownerError"));});return ()=>{active=false;};},[load,t]);
 const row=rows.find(x=>x.id===selected);
 async function action(name:string,extra:Record<string,string>={}){
  if(busy)return;setBusy(true);setMessage("");
  try{
   const res=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({businessId,action:name,...extra})});
   if(!res.ok)throw Error("unavailable");
   const result=await res.json() as {subscriptionId?:string};
   if(result.subscriptionId)setSelected(result.subscriptionId);
   setSecret("");await load();setMessage(t("ownerSaved"));
  }catch{setMessage(t("ownerError"));}
  finally{setBusy(false);}
 }
 return <details className="rounded-xl border border-line p-3">
  <summary className="min-h-12 cursor-pointer font-semibold">{t("webhookSetup")}</summary>
  <div className="flex flex-col gap-3">
   <p className="text-sm text-ink-muted">{t("webhookFallback")}</p>
   <select aria-label={t("webhookSetup")} value={kind} onChange={e=>setKind(e.target.value)} className="min-h-12 rounded-xl border border-line bg-surface px-3">
    {["orders","menus","stock","availability","ordering"].map(k=><option key={k} value={k}>{k}</option>)}
   </select>
   <button type="button" disabled={busy} onClick={()=>void action("prepare",{eventKind:kind})} className="min-h-12 rounded-full border border-line px-4">{t("createWebhook")}</button>
   {rows.length>0&&<select aria-label={t("webhookSetup")} value={selected} onChange={e=>{setSelected(e.target.value);setSecret("");}} className="min-h-12 rounded-xl border border-line bg-surface px-3">
    {rows.map(s=><option key={s.id} value={s.id}>{s.eventKind} — {s.id} — {t(s.enabled?"webhookEnabled":"webhookInactive")}</option>)}
   </select>}
   {row&&<>
    {row.webhookUrl&&<label className="flex flex-col gap-1 text-sm">{t("webhookUrl")}<input readOnly value={row.webhookUrl} onFocus={e=>e.currentTarget.select()} className="min-h-12 rounded-xl border border-line px-3"/></label>}
    {!row.enabled&&<><label className="flex flex-col gap-1 text-sm">{t("webhookSecret")}<input type="password" autoComplete="new-password" value={secret} onChange={e=>setSecret(e.target.value)} className="min-h-12 rounded-xl border border-line px-3"/></label>
     <button type="button" disabled={busy||secret.length<32} onClick={()=>void action("register_secret",{subscriptionId:row.id,signingSecret:secret})} className="min-h-12 rounded-full border border-line px-4 disabled:opacity-40">{t("saveWebhookSecret")}</button></>}
    <button type="button" disabled={busy||(!row.enabled&&(!ready||!row.secretStored))} onClick={()=>void action(row.enabled?"deactivate":"activate",{subscriptionId:row.id})} className="min-h-12 rounded-full bg-accent px-4 text-on-accent disabled:opacity-40">{t(row.enabled?"webhookDeactivate":"webhookActivate")}</button>
   </>}
   {message&&<p role="status" className="text-sm">{message}</p>}
  </div>
 </details>;
}
