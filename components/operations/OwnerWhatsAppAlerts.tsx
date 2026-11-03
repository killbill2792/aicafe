"use client";
import {useCallback,useEffect,useState} from "react";
import {createBrowserSupabaseClient} from "@/lib/supabase/client";

type Thread={id:string;title:string|null};
type Setup={verifiedPhone:string|null;binding:{id:string;threadId:string}|null;threads:Thread[];businessId:string};
type Copy={
  title:string;description:string;loading:string;saved:string;error:string;
  verifiedPhone:string;phoneLabel:string;sendCode:string;codeLabel:string;
  confirmCode:string;codeSent:string;threadLabel:string;connect:string;
  disconnect:string;consent:string;connected:string;noThreads:string;
};

const validPhone=(s:string)=>/^\+[1-9][0-9]{7,14}$/.test(s);

export default function OwnerWhatsAppAlerts({copy}:{copy:Copy}){
  const [setup,setSetup]=useState<Setup|null>(null);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [phone,setPhone]=useState("");
  const [code,setCode]=useState("");
  const [codeRequested,setCodeRequested]=useState(false);
  const [threadId,setThreadId]=useState("");
  const [consent,setConsent]=useState(false);
  const [notice,setNotice]=useState("");

  const reload=useCallback(async()=>{
    const res=await fetch("/api/whatsapp/binding",{cache:"no-store"});
    if(!res.ok)throw new Error("binding_unavailable");
    const data=await res.json() as Setup;
    setSetup(data);
    return data;
  },[]);
  useEffect(()=>{
    let active=true;
    void reload().catch(()=>{if(active)setNotice(copy.error)})
      .finally(()=>{if(active)setLoading(false)});
    return ()=>{active=false};
  },[reload,copy.error]);

  async function requestCode(){
    if(saving)return;
    const normalized=phone.trim();
    if(!validPhone(normalized)){setNotice(copy.verifiedPhone);return;}
    setSaving(true);setNotice("");
    try{
      const {error}=await createBrowserSupabaseClient().auth.updateUser({phone:normalized});
      if(error)throw error;
      setPhone(normalized);setCodeRequested(true);setNotice(copy.codeSent);
    }catch{setNotice(copy.error);}
    finally{setSaving(false);}
  }
  async function confirmCode(){
    if(saving||!/^\d{6,8}$/.test(code.trim())){setNotice(copy.error);return;}
    setSaving(true);setNotice("");
    try{
      const client=createBrowserSupabaseClient();
      const {error}=await client.auth.verifyOtp({type:"phone_change",phone,token:code.trim()});
      if(error)throw error;
      const state=await reload();
      if(!state.verifiedPhone)throw new Error("phone_not_confirmed");
      setCodeRequested(false);setCode("");setNotice(copy.saved);
    }catch{setNotice(copy.error);}
    finally{setSaving(false);}
  }
  async function connect(){
    if(saving||!threadId||!consent)return;
    setSaving(true);setNotice("");
    try{
      const response=await fetch("/api/whatsapp/binding",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({threadId,consent:true}),
      });
      if(!response.ok)throw new Error("connect_failed");
      await reload();
      setConsent(false);setNotice(copy.connected);
    }catch{setNotice(copy.error);}
    finally{setSaving(false);}
  }
  async function disconnect(){
    if(saving)return;
    setSaving(true);setNotice("");
    try{
      const response=await fetch("/api/whatsapp/binding",{method:"DELETE"});
      if(!response.ok)throw new Error("disconnect_failed");
      await reload();setNotice(copy.saved);
    }catch{setNotice(copy.error);}
    finally{setSaving(false);}
  }

  return <section className="rounded-2xl border border-line bg-card p-4">
    <h2 className="font-headline text-2xl font-bold text-ink">{copy.title}</h2>
    <p className="mt-2 text-[17px] leading-relaxed text-ink-muted">{copy.description}</p>
    {loading?<p className="mt-3 text-[17px] text-ink-muted">{copy.loading}</p>
      :setup?.binding&&setup.verifiedPhone?<>
        <p className="mt-3 text-[17px] font-semibold text-good">{copy.connected}: {setup.verifiedPhone}</p>
        <button type="button" onClick={()=>void disconnect()} disabled={saving}
          className="mt-3 min-h-12 rounded-full border border-line px-5 text-[17px] font-bold text-ink disabled:opacity-50">
          {saving?copy.loading:copy.disconnect}
        </button>
      </>:setup?.verifiedPhone?<>
        <p className="mt-3 text-[17px] text-ink">{copy.verifiedPhone}: {setup.verifiedPhone}</p>
        {setup.threads.length?<>
          <label className="mt-3 block text-[17px] font-semibold text-ink" htmlFor="whatsapp-thread">{copy.threadLabel}</label>
          <select id="whatsapp-thread" value={threadId} onChange={e=>setThreadId(e.target.value)}
            className="mt-2 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px] text-ink">
            <option value="">—</option>
            {setup.threads.map(t=><option key={t.id} value={t.id}>{t.title||t.id.slice(0,8)}</option>)}
          </select>
          <label className="mt-3 flex items-start gap-3 text-[17px] text-ink">
            <input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}
              className="mt-1 h-6 w-6 shrink-0" />
            <span>{copy.consent}</span>
          </label>
          <button type="button" onClick={()=>void connect()} disabled={!threadId||!consent||saving}
            className="mt-3 min-h-12 rounded-full bg-accent px-5 text-[17px] font-bold text-on-accent disabled:opacity-40">
            {saving?copy.loading:copy.connect}
          </button>
        </>:<p className="mt-3 text-[17px] text-ink-muted">{copy.noThreads}</p>}
      </>:!codeRequested?<>
        <label className="mt-3 block text-[17px] font-semibold text-ink" htmlFor="whatsapp-phone">{copy.phoneLabel}</label>
        <input id="whatsapp-phone" inputMode="tel" autoComplete="tel" type="tel" value={phone}
          onChange={e=>setPhone(e.target.value)} placeholder="+1 555 123 4567"
          className="mt-2 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px] text-ink"/>
        <button type="button" onClick={()=>void requestCode()} disabled={saving}
          className="mt-3 min-h-12 rounded-full bg-accent px-5 text-[17px] font-bold text-on-accent disabled:opacity-40">
          {saving?copy.loading:copy.sendCode}
        </button>
      </>:<>
        <label className="mt-3 block text-[17px] font-semibold text-ink" htmlFor="whatsapp-code">{copy.codeLabel}</label>
        <input id="whatsapp-code" inputMode="numeric" autoComplete="one-time-code" value={code}
          onChange={e=>setCode(e.target.value)} maxLength={8}
          className="mt-2 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px] text-ink"/>
        <button type="button" onClick={()=>void confirmCode()} disabled={saving}
          className="mt-3 min-h-12 rounded-full bg-accent px-5 text-[17px] font-bold text-on-accent disabled:opacity-40">
          {saving?copy.loading:copy.confirmCode}
        </button>
      </>}
    {notice&&<p role="status" aria-live="polite" className="mt-3 text-[17px] text-ink-muted">{notice}</p>}
  </section>;
}
