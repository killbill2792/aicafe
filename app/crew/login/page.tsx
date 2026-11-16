"use client";
import {useState,type FormEvent} from "react";
import {createBrowserSupabaseClient,isSupabaseConfigured} from "@/lib/supabase/client";
export default function CrewLogin(){
 const [email,setEmail]=useState(""),[password,setPassword]=useState("");
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();setBusy(true);setError("");
  try{
   if(!isSupabaseConfigured())throw new Error("Unavailable");
   const {error}=await createBrowserSupabaseClient().auth.signInWithPassword({email,password});
   if(error)throw error;
   window.location.assign("/crew");
  }catch{setError("Unable to sign in. Check your existing staff login.");setBusy(false);}
 }
 return <section className="space-y-5 rounded-3xl border border-line bg-card p-6">
  <p className="text-sm font-semibold text-ink-muted">AI CAFE · Staff access</p>
  <h1 className="text-3xl font-bold">My work</h1>
  <p className="text-ink-muted">Sign in with the account your café owner provided.</p>
  <form onSubmit={submit} className="space-y-4">
   <label className="block text-sm font-semibold" htmlFor="crew-email">Email</label>
   <input id="crew-email" type="email" autoComplete="email" required value={email}
    onChange={e=>setEmail(e.target.value)}
    className="w-full rounded-xl border border-line bg-white px-4 py-3 text-ink"/>
   <label className="block text-sm font-semibold" htmlFor="crew-password">Password</label>
   <input id="crew-password" type="password" autoComplete="current-password" required value={password}
    onChange={e=>setPassword(e.target.value)}
    className="w-full rounded-xl border border-line bg-white px-4 py-3 text-ink"/>
   <button disabled={busy} className="min-h-12 w-full rounded-full bg-accent px-5 py-3 font-semibold text-on-accent disabled:opacity-50">
    {busy?"Signing in…":"Sign in"}
   </button>
  </form>
  {error&&<p role="alert" className="text-warn">{error}</p>}
 </section>;
}
