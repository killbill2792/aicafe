"use client";
import {useState,useTransition} from "react";
import {useRouter} from "next/navigation";
import {useTranslations} from "next-intl";
import {Link} from "@/i18n/navigation";
import {updateTeamRules,addCustomRule,removeCustomRule} from "@/lib/actions/teamRules";
import OliviaRuleReviewPanel from "./OliviaRuleReviewPanel";

type RuleValues=Record<string,unknown>&{owner_set:string[];custom:{id:string;rule_text:string}[]};
const groups=[
 {title:"breaks",items:[["meal_break_enabled","mealBreak"],["meal_break_minutes","mealMinutes"],["meal_break_after_minutes","mealAfter"],["rest_break_enabled","paidRest"],["rest_break_minutes","restMinutes"],["rest_break_every_minutes","restEvery"]]},
 {title:"overtime",items:[["weekly_ot_enabled","weeklyOvertime"],["weekly_ot_after_minutes","weeklyAfter"],["ot_multiplier_bp","multiplier"],["daily_ot_enabled","dailyOvertime"],["daily_ot_after_minutes","dailyAfter"]]},
 {title:"shifts",items:[["max_shift_enabled","longestShift"],["max_shift_minutes","longestMinutes"],["min_shift_enabled","shortestShift"],["min_shift_minutes","shortestMinutes"],["min_rest_enabled","betweenShifts"],["min_rest_minutes","betweenMinutes"]]},
 {title:"coverage",items:[["coverage_enabled","minimumCoverage"],["min_headcount","peopleWhileOpen"]]}
] as const;
const bounds:Record<string,[number,number,number]>={
 meal_break_minutes:[0,240,10],meal_break_after_minutes:[0,1440,30],
 rest_break_minutes:[0,60,5],rest_break_every_minutes:[60,1440,30],
 weekly_ot_after_minutes:[0,10080,60],ot_multiplier_bp:[10000,50000,500],
 daily_ot_after_minutes:[0,1440,30],max_shift_minutes:[30,1440,30],
 min_shift_minutes:[0,1440,30],min_rest_minutes:[0,1440,30],min_headcount:[1,30,1]
};
export default function RulesWorkspace({initial,week,readOnly=false}:{initial:RuleValues;week:string;readOnly?:boolean}){
 const t=useTranslations("StaffSchedule");const router=useRouter();
 const [values,setValues]=useState(initial),[draft,setDraft]=useState(""),[pending,transition]=useTransition();
 const [message,setMessage]=useState(""),[undo,setUndo]=useState<{key:string;value:number|boolean}|null>(null);
 const change=(key:string,value:number|boolean)=>{
   if(readOnly)return;
   const before=values[key] as number|boolean;
   setValues(prev=>({...prev,[key]:value,owner_set:[...new Set([...prev.owner_set,key])]}));
   setUndo({key,value:before});
   transition(async()=>{
     const res=await updateTeamRules({[key]:value});
     if(!res.ok){setValues(prev=>({...prev,[key]:before}));setUndo(null);setMessage(t("saveFailed"));}
     else {setMessage(t("saved"));router.refresh();}
   });
 };
 const refresh=async()=>{router.refresh();};
 return <div className="mx-auto max-w-3xl space-y-4 text-fg">
   <Link href="/staff" className="inline-flex min-h-12 items-center text-accent-text">← {t("schedule")}</Link>
   <h1 className="font-headline text-2xl font-extrabold">{t("rules")}</h1>
   <p className="rounded-2xl bg-accent-soft p-4">{t("ruleInfo")}</p>
   {readOnly&&<p className="rounded-xl bg-surface2 p-3 text-muted">{t("readOnly")}</p>}
   {groups.map(group=><section key={group.title} className="rounded-[20px] border border-line bg-surface p-4">
    <h2 className="mb-2 text-xl font-bold">{t(group.title)}</h2>
    {group.items.map(([key,label])=><div key={key} className="flex min-h-16 items-center gap-3 border-t border-line py-2">
      <div className="min-w-0 flex-1"><div className="font-semibold">{t(label)}</div>
       <div className="text-sm text-muted">{values.owner_set.includes(key)?t("yours"):t("defaultRule")}</div></div>
      {typeof values[key]==="boolean"?<button type="button" role="switch" aria-checked={Boolean(values[key])}
       disabled={pending||readOnly} onClick={()=>change(key,!values[key])}
       className={`min-h-12 min-w-20 rounded-full px-3 ${values[key]?"bg-accent text-on-accent":"bg-surface2"}`}>
        {values[key]?t("on"):t("off")}</button>:
       <div className="flex items-center rounded-xl bg-surface2">
        <button type="button" aria-label={t("decrease",{item:t(label)})} disabled={pending||readOnly}
         onClick={()=>change(key,Math.max(bounds[key]?.[0]??0,Number(values[key])-(bounds[key]?.[2]??1)))}
         className="min-h-12 min-w-12">−</button>
        <b className="min-w-12 text-center" dir="ltr">{String(values[key])}</b>
        <button type="button" aria-label={t("increase",{item:t(label)})} disabled={pending||readOnly}
         onClick={()=>change(key,Math.min(bounds[key]?.[1]??10080,Number(values[key])+(bounds[key]?.[2]??1)))}
         className="min-h-12 min-w-12">+</button></div>}
     </div>)}
   </section>)}
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
      if(result.ok){setDraft("");router.refresh();setMessage(t("saved"));}
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
       const last=undo;setUndo(null);change(last.key,last.value);
      }} className="min-h-12 rounded-lg px-3 font-bold text-accent-text">{t("undo")}</button>
    </div>}
   {message&&<p role="status" className="text-sm text-muted">{message}</p>}
   <p className="text-sm text-muted">{t("legalNote")}</p>
 </div>;
}