"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {useRouter} from "next/navigation";
import {createBrowserSupabaseClient} from "@/lib/supabase/client";
import {deliverVerifiedReceiptWithRetry} from "./pendingSend";
import {ownerPendingKey,ownerRejectedDraftKey,parseOwnerPending,loadOwnerPending,saveOwnerPending,ownerPendingApiPayload,
 type OwnerPending} from "./ownerPending";

/** One owner-authorized staff action per distinct tab outbox. Never issue a
 * second identity while the first outcome is uncertain, even after reload. */
export function useOwnerStaffOutbox(options:{
 type:OwnerPending["type"];ownerUserId:string;businessId:string;
 endpoint:string;onRestored:(pending:OwnerPending)=>void;
 onConfirmed:(pending:OwnerPending)=>void;
 onRejected:(pending:OwnerPending)=>void;
}){
 const {type,ownerUserId,businessId,endpoint,onRestored,onConfirmed,onRejected}=options;
 const key=ownerPendingKey(ownerUserId,businessId,type);
 const draftKey=ownerRejectedDraftKey(ownerUserId,businessId,type);
 const router=useRouter(),pendingRef=useRef<OwnerPending|null>(null);
 const inFlight=useRef(false);
 const [pending,setPending]=useState<OwnerPending|null>(null);
 const [rejectedDraft,setRejectedDraft]=useState<OwnerPending|null>(null);
 const [busy,setBusy]=useState(false),[status,setStatus]=useState("");
 const retry=useCallback(async()=>{
  const operation=pendingRef.current;
  if(!operation||inFlight.current)return;
  inFlight.current=true;setBusy(true);setStatus("Verifying saved request…");
  try{
   const outcome=await deliverVerifiedReceiptWithRetry<OwnerPending>(operation,async payload=>{
    // No replays under a different authenticated owner after an account switch.
    const auth=await createBrowserSupabaseClient().auth.getUser();
    if(auth.error||auth.data.user?.id!==ownerUserId)
     throw new Error("Owner identity changed");
    const abort=new AbortController();
    const timer=window.setTimeout(()=>abort.abort(),20_000);
    try{
     const response=await fetch(endpoint,{method:"POST",credentials:"same-origin",
      headers:{"Content-Type":"application/json"},body:JSON.stringify(ownerPendingApiPayload(payload)),
      signal:abort.signal});
     if(response.status===409){
      const error=await response.json();
      if(error?.error==="stale_request")return {error:"stale_request"};
      // A generic nonce conflict is NOT evidence of a non-commit.
      throw new Error("Uncertain owner request");
     }
     if(!response.ok)throw new Error("Receipt not established");
     return await response.json();
    }finally{window.clearTimeout(timer);}
   });
   if(outcome.status==="stale_request"){
    // The owner-only SQL already checked this exact nonce under the worker
    // lock. There is no committed receipt and the employee is unavailable.
    // Preserve the original wording before releasing the old submission.
    try{window.sessionStorage.setItem(draftKey,JSON.stringify(operation));}
    catch{
     setStatus("Unable to preserve the unsent draft. The original pending "+
      "request remains available to copy; no new request was sent.");
     return;
    }
    setRejectedDraft(operation);
    try{window.sessionStorage.removeItem(key);}catch{/* Exact replay remains safe. */}
    pendingRef.current=null;setPending(null);
    onRejected(operation);
    setStatus("That employee is no longer available for new work. Nothing "+
     "was sent; your original wording is saved below as an unsent draft.");
    router.refresh();
    return;
   }
   if(outcome.status!=="confirmed"){
    setStatus("Save not confirmed. The original employee, text and request ID are preserved. "+
     "Automatic retry is scheduled; you can retry the same request now.");
    return;
   }
   // Never signal saved until a complete server receipt is verified.
   try{window.sessionStorage.removeItem(key);}catch{/* Same nonce still safe on reload. */}
   pendingRef.current=null;setPending(null);
   onConfirmed(operation);
   setStatus(type==="message"?
    "Message saved in the employee's inbox (not a read receipt).":
    "Assignment saved in the employee's inbox.");
   router.refresh();
  }catch{
   setStatus("Save outcome unknown. Original request preserved for retry.");
  }finally{inFlight.current=false;setBusy(false);}
 },[ownerUserId,key,draftKey,type,endpoint,onConfirmed,onRejected,router]);
 const submit=useCallback((proposed:OwnerPending)=>{
  if(proposed.type!==type||inFlight.current)return;
  try{
   const storage=window.sessionStorage;
   const raw=storage.getItem(key),existing=parseOwnerPending(raw,type);
   // If recovery data is malformed, fail closed rather than lose a prior
   // operation whose commit result could be unknown.
   if(raw!==null&&!existing){
    setStatus("The saved pending request could not be verified. No new message was sent.");
    return;
   }
   const value=existing??proposed;
   if(!existing)saveOwnerPending(storage,key,value);
   pendingRef.current=value;setPending(value);
   if(existing)onRestored(existing);
   void retry();
  }catch{
   setStatus("Browser recovery storage is unavailable. No request was sent.");
  }
 },[type,key,onRestored,retry]);
 useEffect(()=>{
  // Recovery happens after hydration, never synchronously inside the effect.
  const timer=window.setTimeout(()=>{
   if(pendingRef.current)return;
   try{
    const original=loadOwnerPending(window.sessionStorage,draftKey,type);
    if(original)setRejectedDraft(original);
    const raw=window.sessionStorage.getItem(key);
    const saved=loadOwnerPending(window.sessionStorage,key,type);
    if(raw!==null&&!saved){
     setStatus("A pending request could not be decoded; it was not replaced.");
     return;
    }
    if(saved){
     pendingRef.current=saved;setPending(saved);
     onRestored(saved);
     void retry();
    }
   }catch{setStatus("Recovery storage is unavailable; no request was sent.");}
  },0);
  return()=>window.clearTimeout(timer);
 },[key,draftKey,type,onRestored,retry]);
 useEffect(()=>{
  if(!pending||busy)return;
  // Keep retrying conservatively while this owner tab is open, and resume
  // from its original nonce on remount. No new writes or different payload.
  const timer=window.setTimeout(()=>void retry(),30_000);
  return()=>window.clearTimeout(timer);
 },[pending,busy,retry]);
 const dismissDraft=useCallback(()=>{
  try{window.sessionStorage.removeItem(draftKey);}catch{}
  setRejectedDraft(null);
 },[draftKey]);
 return {pending,rejectedDraft,busy,status,submit,retry,dismissDraft};
}
