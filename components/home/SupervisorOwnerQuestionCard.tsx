"use client";
import {useState} from "react";
import {X} from "lucide-react";
import type {OwnerQuestion} from "@/lib/ai/supervisor/ownerInput/contracts";

export type OwnerCardCopy={dismiss:string;confirm:string;other:string;answer:string};
export default function SupervisorOwnerQuestionCard({
  card,locale,copy,disabled=false,allowOther=true,onAnswer,onDismiss,
}:{
  card:OwnerQuestion;locale:"en"|"es"|"ar";copy:OwnerCardCopy;
  disabled?:boolean;allowOther?:boolean;
  onAnswer:(value:string,isOption:boolean)=>void;onDismiss:()=>void;
}){
  const [answer,setAnswer]=useState("");
  const [showOther,setShowOther]=useState(false);
  const [closed,setClosed]=useState(false);
  if(closed)return null;
  const options=card.input.kind==="options"?card.input.options:[];
  const typing=card.input.kind==="free_text"||showOther;
  return <section dir={locale==="ar"?"rtl":"ltr"}
    className="w-full max-w-2xl rounded-[22px] border border-[#D8C8B5] bg-white p-4 text-ink shadow-sm"
    aria-label={card.title[locale]}>
    <div className="flex items-start gap-3">
      <h3 className="min-w-0 flex-1 font-headline text-xl font-bold leading-snug">{card.title[locale]}</h3>
      <button type="button" aria-label={copy.dismiss} title={copy.dismiss}
        disabled={disabled}
        className="flex min-h-12 min-w-12 items-center justify-center rounded-xl text-ink-muted hover:bg-[#F3ECE3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        onClick={()=>{setClosed(true);onDismiss();}}><X size={21} aria-hidden="true"/></button>
    </div>
    {card.input.kind==="options"&&<div role="group" aria-label={card.title[locale]}
      className={`mt-3 flex flex-col gap-2 ${options.length>5?"max-h-72 overflow-y-auto pe-1":""}`}>
      {options.map((option,index)=><button key={option.id} type="button" disabled={disabled}
        onClick={()=>onAnswer(option.id,true)}
        className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-[#E9DAC8] bg-[#FFF9F1] p-2 text-start text-[17px] hover:bg-[#F2E9DA] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white font-bold text-ink-muted">{String.fromCharCode(65+index)}</span>
        <span className="min-w-0 flex-1">{option.label[locale]}</span>
      </button>)}
    </div>}
    {card.input.kind==="options"&&allowOther&&!showOther&&<button type="button"
      className="mt-2 min-h-12 text-[17px] font-semibold text-good underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
      disabled={disabled} onClick={()=>setShowOther(true)}>{copy.other}</button>}
    {typing&&<form className="mt-3 flex flex-col gap-2" onSubmit={e=>{
      e.preventDefault();if(answer.trim()&&!disabled)onAnswer(answer.trim(),false);
    }}>
      <label htmlFor={"owner-input-"+card.questionId} className="text-[17px] font-semibold">
        {copy.answer}
      </label>
      <input id={"owner-input-"+card.questionId} type="text" value={answer}
        maxLength={200} disabled={disabled} onChange={e=>setAnswer(e.target.value)}
        placeholder={card.input.kind==="free_text"?card.input.hint[locale]:copy.other}
        className="min-h-12 w-full rounded-xl border border-[#BCA996] bg-white px-3 text-[17px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"/>
      <button type="submit" disabled={disabled||!answer.trim()}
        className="min-h-12 self-start rounded-xl bg-ink px-5 text-[17px] font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50">
        {copy.confirm}
      </button>
    </form>}
  </section>;
}
