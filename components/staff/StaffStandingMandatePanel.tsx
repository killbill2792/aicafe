"use client";
import {useEffect,useState} from "react";
import {createBrowserSupabaseClient} from "@/lib/supabase/client";
import english from "@/messages/en.json";

// Task13B is English-only. Existing es/ar catalogs and locale resolution
// remain untouched; all new user-visible words live in messages/en.json.
const copy=english.StaffStandingMandate;

type StaffMandate={id:string;revision:number;capability_id:string;
 staff_week_start:string|null;limit_value:number;expires_at:string;
 revoked_at:string|null;superseded_at:string|null};
type Challenge={challengeId:string};
const capacityOptions=[1,2,3,5,10,15,20,30];
/** Owner-created, VERIFIED PHONE MFA policy. Never auto-enrol a factor, persist
 * OTP in the browser, or infer actual provider delivery from a mandate grant. */
export default function StaffStandingMandatePanel({week,businessId}:{
 week:string;businessId:string;
}){
 const [thread,setThread]=useState("");
 const [factor,setFactor]=useState("");
 const [recipients,setRecipients]=useState(10);
 const [code,setCode]=useState("");
 const [challenge,setChallenge]=useState<Challenge|null>(null);
 const [mandate,setMandate]=useState<StaffMandate|null>(null);
 const [message,setMessage]=useState(copy.loading);
 const [busy,setBusy]=useState(false);
 useEffect(()=>{
  let live=true;
  async function load(){
   try{
    const db=createBrowserSupabaseClient();
    const {data:{user},error:userError}=await db.auth.getUser();
    if(userError||!user)throw new Error("Authenticated owner required");
    const [factors,threads]=await Promise.all([
     db.auth.mfa.listFactors(),
     db.from("ai_threads").select("id").eq("business_id",businessId)
      .eq("owner_user_id",user.id).order("updated_at",{ascending:false}).limit(1),
    ]);
    if(!live)return;
    if(factors.error||threads.error)throw new Error("Owner verification unavailable");
    const found=factors.data?.phone?.find(x=>x.status==="verified");
    const currentThread=threads.data?.[0]?.id??"";
    if(!found||!currentThread){
     setMessage(!found?copy.phoneFactorRequired:
       copy.conversationRequired);
     return;
    }
    setFactor(found.id);setThread(currentThread);
    const response=await fetch(`/api/ai/threads/${encodeURIComponent(currentThread)}/mandates`,{
     credentials:"same-origin",cache:"no-store",
    });
    if(!response.ok)throw new Error("Mandate status unavailable");
    const payload=await response.json() as {mandates?:StaffMandate[]};
    if(!live)return;
    const active=(payload.mandates??[]).find(m=>
     m.capability_id==="olivia.staff_propose_send_schedule.v2"&&
     m.staff_week_start===week&&!m.revoked_at&&!m.superseded_at&&
     Date.parse(m.expires_at)>Date.now());
    setMandate(active??null);
    setMessage(active?copy.authorityVerified:
      copy.authorityMissing);
   }catch{if(live)setMessage(copy.verificationUnavailable);}
  }
  void load();
  return()=>{live=false;};
 },[businessId,week]);
 const request=async(body:Record<string,unknown>)=>{
  if(!thread)throw new Error("Supervisor thread unavailable");
  const response=await fetch(`/api/ai/threads/${encodeURIComponent(thread)}/mandates`,{
   method:"POST",credentials:"same-origin",
   headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
  });
  if(!response.ok)throw new Error("Mandate authorization rejected");
  return response.json() as Promise<{challenge?:Challenge;mandate?:StaffMandate}>;
 };
 const start=async()=>{
  if(!factor||busy)return;
  setBusy(true);setMessage(copy.challengeRequesting);
  try{
   const expiry=new Date(Date.parse(week+"T00:00:00Z")+6*86400000).toISOString();
   const response=await request({action:"staff_challenge",factorId:factor,
    weekStart:week,limitValue:recipients,expiresAt:expiry});
   if(!response.challenge?.challengeId)throw new Error("Missing challenge receipt");
   setChallenge(response.challenge);
   setCode("");
   setMessage(copy.challengeInstructions);
  }catch{setMessage(copy.challengeRejected);}
  finally{setBusy(false);}
 };
 const verify=async()=>{
  if(!challenge||!code.trim()||busy)return;
  setBusy(true);
  try{
   const response=await request({action:"verify",challengeId:challenge.challengeId,code:code.trim()});
   if(response.mandate?.capability_id!=="olivia.staff_propose_send_schedule.v2"||
      response.mandate.staff_week_start!==week)
    throw new Error("Wrong mandate receipt");
   setMandate(response.mandate);setChallenge(null);setCode("");
   setMessage(copy.grantConfirmed);
  }catch{setMessage(copy.grantRejected);}
  finally{setBusy(false);}
 };
 const revoke=async()=>{
  if(!mandate||busy)return;
  setBusy(true);
  try{
   const response=await request({action:"revoke",mandateId:mandate.id,revision:mandate.revision});
   if(!response.mandate?.revoked_at)throw new Error("No revocation receipt");
   setMandate(null);setChallenge(null);setCode("");
   setMessage(copy.revokeConfirmed);
  }catch{setMessage(copy.revokeRejected);}
  finally{setBusy(false);}
 };
 return <section className="mt-4 rounded-2xl border border-line bg-surface p-4"
  aria-label={copy.regionLabel}>
  <h3 className="text-lg font-semibold">{copy.title}</h3>
  <p className="mt-2 text-[17px]">{copy.weekOf} {week}. {copy.scopeDescription}</p>
  <p className="mt-2 text-sm text-ink-muted" role="status">{message}</p>
  {mandate?<div className="mt-3">
   <p className="text-[17px]">{copy.activeStart} {mandate.limit_value} {copy.activeEnd} {mandate.expires_at}</p>
   <button type="button" disabled={busy} onClick={()=>void revoke()}
    className="mt-2 min-h-12 rounded-xl border border-line px-4 font-semibold">
    {copy.revokeButton}
   </button>
  </div>:challenge?<div className="mt-3 flex flex-wrap items-end gap-3">
   <label className="text-[17px]">{copy.phoneCode}
    <input type="text" autoComplete="one-time-code" inputMode="numeric"
     value={code} onChange={event=>setCode(event.target.value)}
     maxLength={32} className="mt-1 block min-h-12 rounded-xl border border-line bg-surface p-3"/>
   </label>
   <button type="button" disabled={busy||!code.trim()} onClick={()=>void verify()}
    className="min-h-12 rounded-xl border border-line px-4 font-semibold">
    {copy.verifyButton}
   </button>
  </div>:thread&&factor?<div className="mt-3 flex flex-wrap items-end gap-3">
   <label className="text-[17px]">{copy.maxEmployees}
    <select value={recipients} onChange={event=>setRecipients(Number(event.target.value))}
     className="mt-1 block min-h-12 rounded-xl border border-line bg-surface p-3">
     {capacityOptions.map(n=><option value={n} key={n}>{n}</option>)}
    </select>
   </label>
   <button type="button" disabled={busy} onClick={()=>void start()}
    className="min-h-12 rounded-xl border border-line px-4 font-semibold">
    {copy.challengeButton}
   </button>
  </div>:null}
  <p className="mt-3 text-sm text-ink-muted">{copy.providerNotice}</p>
 </section>;
}
