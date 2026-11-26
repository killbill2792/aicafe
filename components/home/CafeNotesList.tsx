"use client";
import {useEffect,useState} from "react";
import en from "@/messages/en.json";

type Note={topic:string;note:string;basis:string;created_at:string;confirmed_at:string};
const copy=en.SupervisorExperience;

/** Read-only view of what Supervisor has learned about the café, with a Forget control per note. */
export default function CafeNotesList({disabled=false}:{disabled?:boolean}){
  const [notes,setNotes]=useState<Note[]|null>(null);
  const [failed,setFailed]=useState(false);
  useEffect(()=>{
    let live=true;
    fetch("/api/ai/cafe-notes",{credentials:"same-origin",cache:"no-store"})
      .then(r=>r.ok?r.json():Promise.reject(new Error("notes")))
      .then((p:{notes?:Note[]})=>{if(live)setNotes(Array.isArray(p.notes)?p.notes:[]);})
      .catch(()=>{if(live)setFailed(true);});
    return()=>{live=false;};
  },[]);
  async function forget(topic:string){
    const r=await fetch("/api/ai/cafe-notes",{method:"POST",credentials:"same-origin",
      headers:{"content-type":"application/json"},body:JSON.stringify({action:"forget",topic})});
    if(r.ok)setNotes(list=>(list??[]).filter(n=>n.topic!==topic));else setFailed(true);
  }
  if(failed)return <p role="alert" className="text-sm text-ink-muted">{copy.cafeNotesUnavailable}</p>;
  if(notes===null)return null;
  return <section aria-label={copy.cafeNotes} className="border-t border-line pt-3">
    <h3 className="text-[0.9375rem] font-medium text-ink-muted">{copy.cafeNotes}</h3>
    {notes.length===0&&<p className="text-sm text-ink-muted">{copy.cafeNotesEmpty}</p>}
    <ul className="space-y-2">{notes.map(n=><li key={n.topic} data-cafe-note={n.topic} className="rounded-lg px-2 py-1">
      <p className="wrap-break-word text-[1.0625rem] text-ink">{n.note}</p>
      <p className="text-[0.8125rem] text-ink-muted">{n.basis}</p>
      <button type="button" disabled={disabled} onClick={()=>void forget(n.topic)}
        className="min-h-12 text-[0.9375rem] text-ink underline">{copy.cafeNotesForget}</button>
    </li>)}</ul>
  </section>;
}
