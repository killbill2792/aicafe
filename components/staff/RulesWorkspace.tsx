"use client";
import {useId,useState,useTransition} from "react";
import {partsToMinutes,minutesToParts,wholeRuleValue,multiplierToBasisPoints,basisPointsToMultiplier} from "@/lib/calc/scheduling/ruleInputValues";
import {useRouter} from "next/navigation";
import {useLocale,useTranslations} from "next-intl";
import PayrollCostCard from "./PayrollCostCard";
import type {PayrollCostSettings} from "@/lib/data/getPayrollCostSettings";
import {Link} from "@/i18n/navigation";
import {updateTeamRules,addCustomRule,removeCustomRule} from "@/lib/actions/teamRules";
import OliviaRuleReviewPanel from "./OliviaRuleReviewPanel";

type RuleValues=Record<string,unknown>&{owner_set:string[];custom:{id:string;rule_text:string}[]};
const durationRules = [
 {title:"breaks",rows:[["meal_break_enabled","meal_break_minutes","meal_break_after_minutes","mealBreak","mealSentence"],["rest_break_enabled","rest_break_minutes","rest_break_every_minutes","paidRest","restSentence"]]},
 {title:"overtime",rows:[["weekly_ot_enabled","weekly_ot_after_minutes",null,"weeklyOvertime","weeklySentence"],["daily_ot_enabled","daily_ot_after_minutes",null,"dailyOvertime","dailySentence"]]},
 {title:"shifts",rows:[["max_shift_enabled","max_shift_minutes",null,"longestShift","longestSentence"],["min_shift_enabled","min_shift_minutes",null,"shortestShift","shortestSentence"],["min_rest_enabled","min_rest_minutes",null,"betweenShifts","betweenSentence"]]}
] as const;
const ranges:Record<string,[number,number]>={
 meal_break_minutes:[0,240],meal_break_after_minutes:[0,1440],rest_break_minutes:[0,60],rest_break_every_minutes:[60,1440],
 weekly_ot_after_minutes:[0,10080],daily_ot_after_minutes:[0,1440],max_shift_minutes:[30,1440],min_shift_minutes:[0,1440],
 min_rest_minutes:[0,1440],min_headcount:[1,30],prep_minutes_before_open:[0,240],prep_minutes_after_close:[0,240]
};
function NumberField({value,onCommit,label,min,max,disabled,locale,twoParts=false}:{value:number;onCommit:(v:number)=>void;label:string;min:number;max:number;disabled:boolean;locale:string;twoParts?:boolean}){
 const t=useTranslations("StaffSchedule");const fieldId=useId();
 const format=(n:number)=>new Intl.NumberFormat(locale,{useGrouping:false}).format(n);
 const split=minutesToParts(value);
 const [entry,setEntry]=useState(format(value));
 const [hours,setHours]=useState(format(split.hours));
 const [minutes,setMinutes]=useState(format(split.minutes));
 const [error,setError]=useState(false);
 const current=twoParts?partsToMinutes(hours,minutes,min,max):wholeRuleValue(entry,min,max);
 const commit=()=>{if(current===null){setError(true);return;}setError(false);if(current!==value)onCommit(current)};
 const field=(part:"hours"|"minutes"|"single",v:string,change:(s:string)=>void)=><input
  aria-label={part==="single"?label:label+" "+t(part==="hours"?"hoursInput":"minutesInput")}
  aria-invalid={error} aria-describedby={error?fieldId:undefined}
  inputMode="numeric" type="text" value={v} disabled={disabled}
  onChange={e=>{change(e.target.value);setError(false)}}
  className={`min-h-12 w-16 rounded-xl border bg-surface px-2 text-center text-base ${error?"border-neg":"border-line"}`}/>;
 return <span className="inline-flex flex-wrap items-center gap-1 align-middle" dir={locale==="ar"?"rtl":"ltr"}
  onBlur={event=>{if(event.relatedTarget instanceof Node&&event.currentTarget.contains(event.relatedTarget))return;commit()}}>
  {twoParts?<>{field("hours",hours,setHours)}<span>{t("hoursUnit")}</span>{field("minutes",minutes,setMinutes)}<span>{t("minutesUnit")}</span></>:field("single",entry,setEntry)}
  {error&&<span role="alert" id={fieldId} className="w-full text-sm text-neg">{t("invalidNumber")}</span>}
 </span>;
}
export default function RulesWorkspace({initial,week,readOnly=false,payroll}:{initial:RuleValues;week:string;readOnly?:boolean;payroll:PayrollCostSettings}){
 const t=useTranslations("StaffSchedule");const locale=useLocale();const staffT=useTranslations("Staff");const router=useRouter();
 const [values,setValues]=useState(initial),[draft,setDraft]=useState(""),[pending,transition]=useTransition();
 const [custom,setCustom]=useState(false),[customValue,setCustomValue]=useState(basisPointsToMultiplier(Number(values.ot_multiplier_bp))),[multiplierError,setMultiplierError]=useState(false);
 const [message,setMessage]=useState(""),[undo,setUndo]=useState<{key:string;value:number|boolean}|null>(null);
 const change=(key:string,value:number|boolean)=>{
   if(readOnly)return;
   const before=values[key] as number|boolean;
   const ownerSet=values.owner_set;
   setValues(prev=>({...prev,[key]:value,owner_set:[...new Set([...prev.owner_set,key])]}));
   setUndo({key,value:before});
   transition(async()=>{
     try{
       const res=await updateTeamRules({[key]:value});
       if(!res.ok)throw new Error("save_failed");
       setMessage(t("saved"));
       router.refresh();
     }catch{
       setValues(prev=>({...prev,[key]:before,owner_set:ownerSet}));
       setUndo(null);
       setMessage(t("saveFailed"));
     }
   });
 };
 const refresh=async()=>{router.refresh();};
 return <div className="mx-auto max-w-3xl space-y-4 text-fg">
   <Link href="/staff" className="inline-flex min-h-12 items-center text-accent-text"><span className="inline-block rtl:rotate-180">←</span> {t("schedule")}</Link>
   <h1 className="font-headline text-2xl font-extrabold">{t("rulesAndCosts")}</h1>
   <p className="rounded-2xl bg-accent-soft p-4">{t("ruleInfo")}</p>
   {readOnly&&<p className="rounded-xl bg-surface2 p-3 text-muted">{t("readOnly")}</p>}
   {durationRules.map(group=><section key={group.title} className="rounded-[20px] border border-line bg-surface p-4">
    <h2 className="mb-2 text-xl font-bold">{t(group.title)}</h2>
    {group.rows.map(([enabled,first,second,label,sentence])=><div key={enabled} className="border-t border-line py-3">
      <div className="flex flex-wrap items-center gap-3">
       <label className="flex min-h-12 items-center gap-2 font-semibold"><input type="checkbox" className="size-5" checked={Boolean(values[enabled])} disabled={pending||readOnly} onChange={e=>change(enabled,e.target.checked)}/>{t("applyRule")}</label>
       <span className="text-base">{t(sentence)}</span>
       <NumberField key={first+String(values[first])} value={Number(values[first])} onCommit={v=>change(first,v)} label={t(label)} min={ranges[first][0]} max={ranges[first][1]} disabled={pending||readOnly} locale={locale} twoParts={first!=="meal_break_minutes"&&first!=="rest_break_minutes"}/>
       {(first==="meal_break_minutes"||first==="rest_break_minutes")&&<span>{t("minutesUnit")}</span>}
       {second&&<><span>{t(second==="meal_break_after_minutes"?"after":"every")}</span><NumberField key={second+String(values[second])} value={Number(values[second])} onCommit={v=>change(second,v)} label={t(label)} min={ranges[second][0]} max={ranges[second][1]} disabled={pending||readOnly} locale={locale} twoParts/></>}
      </div>
      <p className="text-sm text-muted">{values.owner_set.includes(first)?t("yours"):t("defaultRule")}</p>
    </div>)}
    {group.title==="overtime"&&<div className="flex flex-wrap items-center gap-3 border-t border-line py-3">
     <label className="font-semibold" htmlFor="ot-rate">{t("overtimePays")}</label>
     <select id="ot-rate" value={custom||![15000,20000].includes(Number(values.ot_multiplier_bp))?"custom":String(values.ot_multiplier_bp)} disabled={pending||readOnly}
      onChange={e=>{if(e.target.value!=="custom"){setCustom(false);setCustomValue(basisPointsToMultiplier(Number(e.target.value)));change("ot_multiplier_bp",Number(e.target.value));}else{setCustom(true);setCustomValue(basisPointsToMultiplier(Number(values.ot_multiplier_bp)));}}}
      className="min-h-12 rounded-xl border border-line bg-surface px-3"><option value="15000">1.5×</option><option value="20000">2×</option><option value="custom">{t("customMultiplier")}</option></select>
     {(custom||![15000,20000].includes(Number(values.ot_multiplier_bp)))&&<label className="flex items-center gap-2">{t("customMultiplier")}
      <input aria-label={t("customMultiplier")} type="text" inputMode="decimal" value={customValue} onChange={e=>{setCustomValue(e.target.value);setMultiplierError(false)}}
      onBlur={()=>{const n=multiplierToBasisPoints(customValue);if(n===null){setMultiplierError(true);return}setMultiplierError(false);if(n!==values.ot_multiplier_bp)change("ot_multiplier_bp",n);}}
      disabled={pending||readOnly} aria-invalid={multiplierError} className={`min-h-12 w-24 rounded-xl border px-3 ${multiplierError?"border-neg":"border-line"}`}/>×</label>}
     {multiplierError&&<span role="alert" className="text-neg">{t("invalidMultiplier")}</span>}
    </div>}
   </section>)}
   <section className="rounded-[20px] border border-line bg-surface p-4">
    <h2 className="text-xl font-bold">{t("coverage")}</h2>
    <label className="flex min-h-12 items-center gap-2"><input className="size-5" type="checkbox" disabled={pending||readOnly} checked={Boolean(values.coverage_enabled)} onChange={e=>change("coverage_enabled",e.target.checked)}/>{t("minimumCoverage")}</label>
    <div className="flex flex-wrap items-center gap-2">{t("atLeast")}<NumberField key={"coverage"+String(values.min_headcount)} value={Number(values.min_headcount)} min={1} max={30} label={t("peopleWhileOpen")} disabled={pending||readOnly} locale={locale} onCommit={v=>change("min_headcount",v)}/>{t("whileOpen")}</div>
   </section>
   <section className="rounded-[20px] border border-line bg-surface p-4">
    <h2 className="text-xl font-bold">{t("prepTiming")}</h2>
    {(["prep_minutes_before_open","prep_minutes_after_close"] as const).map(key=><div key={key} className="flex flex-wrap items-center gap-2 py-2">{t(key==="prep_minutes_before_open"?"prepBeforeOpen":"prepAfterClose")}<NumberField key={key+String(values[key])} value={Number(values[key])} min={0} max={240} label={t(key==="prep_minutes_before_open"?"prepBeforeOpen":"prepAfterClose")} disabled={pending||readOnly} locale={locale} onCommit={v=>change(key,v)} twoParts/></div>)}
   </section>
   <PayrollCostCard settings={payroll} readOnly={readOnly} labels={{
title:staffT("payrollCostsTitle"),body:staffT("payrollCostsBody"),field:staffT("payrollCostsField"),hint:staffT("payrollCostsHint"),source:staffT("payrollSource"),ownerSource:staffT("payrollSourceOwner"),estimateSource:staffT("payrollSourceEstimate"),quickbooksSource:staffT("payrollSourceQuickBooks"),importedSource:staffT("payrollSourceImported"),connectedSource:staffT("payrollSourceConnected"),actualUsing:staffT("payrollActualUsing"),fallbackNote:staffT("payrollFallbackNote"),save:staffT("payrollSave"),saving:staffT("payrollSaving"),saved:staffT("payrollSaved"),invalid:staffT("payrollInvalid"),saveFailed:staffT("payrollSaveFailed")
}}/>
   <section className="rounded-[20px] border border-line bg-surface p-4">
    <h2 className="text-xl font-bold">{t("yourRules")}</h2>
    <p className="my-2 text-muted">{t("writeYourRules")}</p>
    {values.custom.map(rule=><div key={rule.id} className="flex items-center justify-between gap-3 border-t border-line py-2">
      <p>{rule.rule_text}</p><button disabled={pending||readOnly} className="min-h-12 px-3 text-neg"
       onClick={()=>transition(async()=>{const result=await removeCustomRule({id:rule.id});if(result.ok){
        setValues(prev=>({...prev,custom:prev.custom.filter(x=>x.id!==rule.id)}));router.refresh();
       }else setMessage(t("saveFailed"));})}>{t("remove")}</button>
    </div>)}
    <label className="mt-3 block">{t("newRule")}<textarea value={draft} onChange={e=>setDraft(e.target.value)}
     maxLength={500} disabled={readOnly} className="mt-2 min-h-24 w-full rounded-xl border border-line bg-surface p-3"/></label>
    <button disabled={readOnly||pending||!draft.trim()} onClick={()=>transition(async()=>{const result=await addCustomRule({text:draft});
      if(result.ok){setDraft("");setValues(prev=>({...prev,
       custom:[...prev.custom.filter(x=>x.id!==result.data.id),result.data]}));
       router.refresh();setMessage(t("saved"));}
      else setMessage(t("saveFailed"));
    })} className="mt-2 min-h-12 rounded-xl bg-accent px-4 text-on-accent">{t("addRule")}</button>
   </section>
   <details className="rounded-2xl border border-line bg-surface p-4">
    <summary className="min-h-12 cursor-pointer font-bold">{t("advanced")}</summary>
    <p className="mb-4 text-muted">{t("advancedNote")}</p>
    {!readOnly&&<OliviaRuleReviewPanel week={week} onChanged={refresh}/>}
   </details>
   {undo&&<div role="status" className="flex items-center justify-between rounded-xl bg-surface2 p-3">
      <span>{t("saved")}</span><button disabled={pending||readOnly} onClick={()=>{
       const last=undo;setUndo(null);if(last.key==="ot_multiplier_bp"){setCustom(false);setCustomValue(basisPointsToMultiplier(Number(last.value)));}change(last.key,last.value);
      }} className="min-h-12 rounded-lg px-3 font-bold text-accent-text">{t("undo")}</button>
    </div>}
   {message&&<p role="status" className="text-sm text-muted">{message}</p>}
   <p className="text-sm text-muted">{t("legalNote")}</p>
 </div>;
}