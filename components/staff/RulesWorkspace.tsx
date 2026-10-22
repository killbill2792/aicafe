"use client";
import {useState,useTransition} from "react";
import {updateTeamRules,addCustomRule,removeCustomRule} from "@/lib/actions/teamRules";
import Link from "next/link";
type Rules=Record<string,unknown>&{owner_set:string[];custom:{id:string;rule_text:string}[]};
const groups=[
 {title:"Breaks",items:[["meal_break_enabled","Meal break"],["meal_break_minutes","Meal break minutes"],["meal_break_after_minutes","Meal after (min)"],["rest_break_enabled","Paid rest break"],["rest_break_minutes","Rest minutes"],["rest_break_every_minutes","Rest every (min)"]]},
 {title:"Overtime",items:[["weekly_ot_enabled","Weekly overtime"],["weekly_ot_after_minutes","Weekly after (min)"],["ot_multiplier_bp","Overtime multiplier (basis points)"],["daily_ot_enabled","Daily overtime"],["daily_ot_after_minutes","Daily after (min)"]]},
 {title:"Shifts",items:[["max_shift_enabled","Longest shift"],["max_shift_minutes","Longest (min)"],["min_shift_enabled","Shortest shift"],["min_shift_minutes","Shortest (min)"],["min_rest_enabled","Rest between shifts"],["min_rest_minutes","Minimum rest (min)"]]},
 {title:"Coverage",items:[["coverage_enabled","Minimum coverage"],["min_headcount","People while open"]]}
];
export default function RulesWorkspace({initial}:{initial:Rules}){
 const [rules,setRules]=useState(initial),[text,setText]=useState(""),[pending,transition]=useTransition(),[message,setMessage]=useState("");
 const change=(key:string,value:number|boolean)=>{const before=rules[key];
   setRules(prev=>({...prev,[key]:value,owner_set:[...new Set([...prev.owner_set,key])]}));
   transition(async()=>{const r=await updateTeamRules({[key]:value});if(!r.ok){setRules(prev=>({...prev,[key]:before}));setMessage("Could not save this rule");}else setMessage("Saved · change anytime");});
 };
 return <div className="mx-auto max-w-3xl space-y-4 text-fg">
   <Link href="/staff" className="inline-flex min-h-12 items-center text-accent-text">← Schedule</Link>
   <h1 className="font-headline text-2xl font-extrabold">Rules</h1>
   <p className="rounded-2xl bg-accent-soft p-4">Pre-filled with common U.S. café defaults so you can start now. Olivia uses these to build and check your schedule.</p>
   {groups.map(group=><section key={group.title} className="rounded-[20px] border border-line bg-surface p-4">
    <h2 className="mb-2 text-xl font-bold">{group.title}</h2>
    {group.items.map(([key,label])=><div key={key} className="flex min-h-16 items-center gap-3 border-t border-line py-2">
      <div className="min-w-0 flex-1"><div className="font-semibold">{label}</div><div className="text-sm text-muted">{rules.owner_set.includes(key)?"Yours":"Default — change anytime"}</div></div>
      {typeof rules[key]==="boolean"?<button role="switch" aria-checked={Boolean(rules[key])} disabled={pending} onClick={()=>change(key,!rules[key])}
        className={`min-h-12 min-w-20 rounded-full px-3 ${rules[key]?"bg-accent text-on-accent":"bg-surface2"}`}>{rules[key]?"On":"Off"}</button>:
      <div className="flex items-center rounded-xl bg-surface2"><button disabled={pending} onClick={()=>change(key,Math.max(0,Number(rules[key])- (key==="ot_multiplier_bp"?500: key.endsWith("minutes")?30:1)))} className="min-h-12 min-w-12">−</button>
        <b className="min-w-12 text-center">{String(rules[key])}</b><button disabled={pending} onClick={()=>change(key,Number(rules[key])+(key==="ot_multiplier_bp"?500:key.endsWith("minutes")?30:1))} className="min-h-12 min-w-12">+</button></div>}
    </div>)}
   </section>)}
   <section className="rounded-[20px] border border-line bg-surface p-4"><h2 className="text-xl font-bold">Your rules</h2><p className="my-2 text-muted">Write rules in your own words. Olivia sees them alongside the defaults.</p>
    {rules.custom.map(r=><div key={r.id} className="flex items-center justify-between border-t border-line py-2"><p>{r.rule_text}</p><button className="min-h-12 px-3 text-neg" onClick={()=>transition(async()=>{const res=await removeCustomRule({id:r.id});if(res.ok)setRules(s=>({...s,custom:s.custom.filter(x=>x.id!==r.id)}))})}>Remove</button></div>)}
    <label className="mt-3 block">New rule<textarea value={text} onChange={e=>setText(e.target.value)} maxLength={500} className="mt-2 min-h-24 w-full rounded-xl border border-line bg-surface p-3"/></label>
    <button disabled={pending||!text.trim()} onClick={()=>transition(async()=>{const r=await addCustomRule({text});if(r.ok){setText("");window.location.reload()}else setMessage("Could not add rule")})}
      className="mt-2 min-h-12 rounded-xl bg-accent px-4 text-on-accent">+ Add rule</button>
   </section>
   <details className="rounded-2xl border border-line bg-surface p-4"><summary>Advanced · legal review</summary>
    <p>Jurisdiction-specific requirements need a reviewed legal profile before using automated planning.</p>
   </details>
   {message&&<p role="status">{message}</p>}
   <p className="text-muted">Defaults are a starting point, not legal advice — check your state’s rules. Changes save automatically.</p>
 </div>;
}
