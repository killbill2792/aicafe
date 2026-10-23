"use client";
import {useEffect,useState,useTransition} from "react";
import {useRouter} from "next/navigation";
import {useTranslations} from "next-intl";
import {dismissStaffRuleAlert} from "@/lib/actions/ruleAlerts";
import DayTimeline from "./DayTimeline";
import WeekGrid from "./WeekGrid";
import ShiftPreview from "./ShiftPreview";
import {dayTotals,personTotals,bestFreePerson,availabilityStatus,totalOvertimeMinutes,previewShift,type DetailedShift} from "@/lib/calc/scheduling/schedulePresentation";
import {OPEN_HOURS_DAY_KEYS} from "@/lib/business/openHours";
import Link from "next/link";
import {addPerson,updatePerson,setPersonActive} from "@/lib/actions/teamWorkspace";
import {upsertShift,removeShift,restoreShift,copyWeek,sendSchedule} from "@/lib/actions/schedule";
type Data=Extract<Awaited<ReturnType<typeof import("@/lib/actions/schedule").getWeekSchedule>>,{ok:true}>["data"];
const fmt=(c:number|null,currency:string)=>c==null?"—":new Intl.NumberFormat(undefined,{style:"currency",currency}).format(c/100);
const hours=(n:number)=>Number((n/60).toFixed(1));
type Alert={id:string;employee_id:string;rule_key:string;message:string;created_at:string};
export default function StaffWorkspace({initial,tab="schedule",locale="en",initialAlerts=[],alertError=null,teamExtras=null}:{
 initial:Data;tab?:string;locale?:string;initialAlerts?:Alert[];alertError?:string|null;teamExtras?:React.ReactNode
}){
 const router=useRouter();const t=useTranslations("StaffSchedule");
 const roleLabel=(v:string)=>({Barista:t("roleBarista"),Manager:t("roleManager"),Baker:t("roleBaker"),Cashier:t("roleCashier")}[v]??v);
 const [version,setVersion]=useState({initial,local:initial});
 const data=version.initial===initial?version.local:initial;
 const setData=(value:Data)=>setVersion({initial,local:value});
 const [screen,setScreen]=useState(tab),[sheet,setSheet]=useState<"person"|"shift"|null>(null);
 const [busy,startTransition]=useTransition(),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [dismissed,setDismissed]=useState<string[]>([]);
 const [repeatWeekly,setRepeatWeekly]=useState(false),[fillsGap,setFillsGap]=useState(false);
 const [inlineName,setInlineName]=useState(""),[inlineRole,setInlineRole]=useState("Barista");
 const [name,setName]=useState(""),[role,setRole]=useState("Barista"),[wage,setWage]=useState<number|null>(null);
 const [phone,setPhone]=useState(""),[salaryPeriod,setSalaryPeriod]=useState<string|null>(null),[minWeeklyMinutes,setMinWeeklyMinutes]=useState<number|null>(null),
  [maxWeeklyMinutes,setMaxWeeklyMinutes]=useState<number|null>(null),[personEditing,setPersonEditing]=useState<string|null>(null);
 const [chosen,setChosen]=useState(data.team[0]?.id??""),[date,setDate]=useState(data.dates[0]);
 const [start,setStart]=useState("07:00"),[end,setEnd]=useState("15:00"),[breakMin,setBreakMin]=useState(30);
 const [editing,setEditing]=useState<string|null>(null),
 [availability,setAvailability]=useState<{day:number;start:string|null;end:string|null}[]>([]);
 const [undo,setUndo]=useState<{id:string;type:"person"|"shift";message:string}|null>(null);
 useEffect(()=>{if(!undo)return;const timer=setTimeout(()=>setUndo(null),6000);return ()=>clearTimeout(timer);},[undo]);
 const allDays=()=>Array.from({length:7},(_,day)=>({day,start:null,end:null}));
 const run=(fn:()=>Promise<{ok:boolean;error?:string}>)=>startTransition(async()=>{
  setError("");const res=await fn();
  if(!res.ok){setError(res.error??"Could not save");router.refresh();return;}
  setSheet(null);router.refresh();
 });
 const openPerson=(person?:Data["team"][number])=>{
  setPersonEditing(person?.id??null);setName(person?.name??"");setRole(person?.role??"Barista");
  setWage(person?.wageCents??null);setSalaryPeriod(person?.wagePeriod&&person.wagePeriod!=="hour"?person.wagePeriod:null);
  setPhone(person?.phone??"");
  setMinWeeklyMinutes(person?.minWeeklyMinutes??null);setMaxWeeklyMinutes(person?.maxWeeklyMinutes??null);
  if(person){
   const days=person.availableDays??[0,1,2,3,4,5,6];
   setAvailability(days.map(day=>{
    const candidate=data.availability.filter(a=>a.employee_id===person.id&&a.day_of_week===day&&
      a.effective_from<=data.dates[6]&&(a.effective_to===null||a.effective_to>=data.dates[0]))
     .sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    return {day,start:candidate?String(candidate.start_local).slice(0,5):null,
      end:candidate?String(candidate.end_local).slice(0,5):null};
   }));
  }else setAvailability(allDays());
  setSheet("person");
 };
 const mutateAvailability=(day:number,update:{start:string|null;end:string|null}|null)=>{
  setAvailability(current=>update===null?current.filter(d=>d.day!==day):
   [...current.filter(d=>d.day!==day),{day,...update}].sort((a,b)=>a.day-b.day));
 };
 const timeStep=(clock:string,minutes:number)=> {
  const [h,m]=clock.split(":").map(Number);
  const next=((h*60+m+minutes)%1440+1440)%1440;
  return String(Math.floor(next/60)).padStart(2,"0")+":"+String(next%60).padStart(2,"0");
 };
 const openShift=(d:string,id?:string,employeeId?:string)=>{
  const shift=data.shifts.find(s=>s.id===id);setDate(d);setEditing(id??null);setFillsGap(false);setRepeatWeekly(false);
  setChosen(shift?.employeeId??employeeId??data.team[0]?.id??"");
  setStart(shift?.start??"07:00");setEnd(shift?.end??"15:00");setBreakMin(shift?.breakMinutes??30);setSheet("shift");
 };
 const removePerson=()=>{if(!personEditing)return;const id=personEditing,label=name;
  setData({...data,team:data.team.filter(p=>p.id!==id)});
  setUndo({id,type:"person",message:t("removedPerson",{name:label})});
  setSheet(null);run(()=>setPersonActive({id,active:false}));
 };
 const removeCurrentShift=()=>{if(!editing)return;const id=editing;
  setData({...data,shifts:data.shifts.filter(s=>s.id!==id)});
  setUndo({id,type:"shift",message:t("removedShift")});setSheet(null);run(()=>removeShift({id}));
 };
 const undoRemove=()=>{if(!undo)return;const item=undo;setUndo(null);
  run(()=>item.type==="shift"?restoreShift({id:item.id}):setPersonActive({id:item.id,active:true}));
 };
 const fixGap=(gap:Data["gaps"][number])=>{
  const person=bestFreePerson(data.team,gap.date,gap.start,gap.end,data.shifts,data.availability);
  openShift(gap.date,undefined,person?.id);
  setStart(gap.start);setEnd(gap.end);
  setBreakMin(0);
  setFillsGap(true);
 };
 const proposed=sheet==="shift"?previewShift({employeeId:chosen,date,start,end,breakMinutes:breakMin,editingId:editing},
  data.team,data.shifts,data.gaps,data.availability,data.rules,data.timezone):null;
 const previewBlock:DetailedShift|null=proposed?{...proposed.next,id:editing??"preview",
  employeeName:data.team.find(p=>p.id===chosen)?.name??t("team"),status:"draft"}:null;
 const dayLabel=(d:string)=>new Intl.DateTimeFormat(locale,{weekday:"short",day:"numeric",timeZone:"UTC"}).format(new Date(d+"T12:00:00Z"));
 const weekday=(d:string,long=false)=>new Intl.DateTimeFormat(locale,{weekday:long?"long":"short",timeZone:"UTC"}).format(new Date(d+"T12:00:00Z"));
 const status=data.shifts.some(s=>s.status==="sent")?t("sent"):t("draft");
 return <div className="mx-auto w-full max-w-7xl space-y-3 px-4 pb-32 pt-5 text-fg" dir={locale==="ar"?"rtl":"ltr"}>
  <header className="flex items-center justify-between gap-3"><h1 className="font-headline text-2xl font-extrabold">{t("schedule")}</h1>
   <div className="flex gap-2"><Link className="flex min-h-12 items-center rounded-full border border-line px-4" href={`/${locale}/staff/rules`}>{t("rules")}</Link><button disabled={data.readOnly} aria-label={t("addShift")} onClick={()=>openShift(date)} className="min-h-12 min-w-12 rounded-full bg-accent text-on-accent">+</button></div>
  </header>
  {data.readOnly&&<p className="rounded-xl bg-surface2 p-3 text-muted">{t("readOnly")}</p>}
  <div className="grid grid-cols-2 rounded-2xl bg-surface2 p-1">{["schedule","team"].map(k=><button key={k} onClick={()=>setScreen(k)} aria-pressed={screen===k}
    className={`min-h-12 rounded-xl font-bold ${screen===k?"bg-surface shadow":"text-muted"}`}>{k==="schedule"?t("schedule"):t("team")}</button>)}</div>
  {screen==="schedule"?<>
   {alertError&&<p role="alert" className="rounded-xl bg-warn-soft p-3 text-warn-text">{t("ruleAlertError",{error:alertError})}</p>}
   {initialAlerts.filter(a=>!dismissed.includes(a.id)).length>0&&<section className="rounded-2xl border border-line bg-surface p-4">
    <h2 className="text-lg font-bold">{t("ruleAlerts")} · {initialAlerts.filter(a=>!dismissed.includes(a.id)).length}</h2>
    {initialAlerts.filter(a=>!dismissed.includes(a.id)).map(a=><div key={a.id} className="flex items-start gap-3 border-t border-line py-3">
      <span aria-hidden="true">⚠</span><div className="min-w-0 flex-1"><p className="font-semibold">{t(({meal:"ruleMeal",rest_break:"ruleRestBreak",weekly_overtime:"ruleWeeklyOT",daily_overtime:"ruleDailyOT",short_rest:"ruleShortRest"} as Record<string,"ruleMeal"|"ruleRestBreak"|"ruleWeeklyOT"|"ruleDailyOT"|"ruleShortRest">)[a.rule_key]??"ruleMeal")}</p></div>
      <button disabled={busy} className="min-h-12 rounded-lg border border-line px-3" onClick={()=>{setDismissed(ids=>[...ids,a.id]);run(()=>dismissStaffRuleAlert({id:a.id}));}}>{t("dismiss")}</button>
    </div>)}
   </section>}
   <div className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-surface p-3">
    <Link href={`?week=${new Date(Date.parse(data.weekStart+"T12:00:00Z")-7*86400000).toISOString().slice(0,10)}`} className="p-3">‹</Link>
    <div className="text-center font-semibold">{dayLabel(data.dates[0])} – {dayLabel(data.dates[6])}<div className="text-sm text-muted">{status}</div></div>
    <Link href={`?week=${new Date(Date.parse(data.weekStart+"T12:00:00Z")+7*86400000).toISOString().slice(0,10)}`} className="p-3">›</Link>
   </div>
   <div className="grid grid-cols-3 gap-2 lg:grid-cols-4">{[
    [t("paidHours"),String(hours(data.total.paidMinutes))],
    [t("wages"),fmt(data.total.knownCostCents,data.currency)],
    [t("gaps"),String(data.gaps.length)],
    [t("overtime"),String(Number((totalOvertimeMinutes(data.team,data.shifts,data.rules.weekly_ot_after_minutes,data.rules.weekly_ot_enabled)/60).toFixed(1)))+" h"]
   ].map(([label,value])=><div key={label} className={`rounded-2xl border border-line bg-surface p-3 ${label===t("overtime")?"hidden lg:block":""} ${label===t("gaps")&&data.gaps.length?"border-neg bg-neg-soft":""}`}><strong className="block text-xl">{value}</strong><span className="text-sm text-muted">{label}</span></div>)}</div>
   {data.total.estimated&&<p className="rounded-xl bg-warn-soft p-3 text-warn-text">{t("estimateNote",{count:data.total.estimateCount,unknown:data.total.unknownCount})}</p>}
   <nav aria-label={t("weekDays")} className="grid grid-cols-7 gap-1">{data.dates.map((d,i)=>{
    const totals=dayTotals(d,data.shifts);
    return <a key={d} href={"#day-"+d} className={`relative rounded-xl border border-line bg-surface px-1 py-2 text-center text-sm ${i===0?"bg-accent text-on-accent":""}`}>
     {data.gaps.some(g=>g.date===d)&&<span aria-label={t("gap")} className="absolute end-1 top-1 size-2 rounded-full bg-neg"/>}
     <span className="block text-xs font-bold">{weekday(d)}</span>
     <strong className="block font-headline text-lg">{new Date(d+"T12:00:00Z").getUTCDate()}</strong>
     <span className="block text-xs">{Number((totals.paidMinutes/60).toFixed(1))}h</span></a>;
   })}</nav>
   <div className="space-y-3 lg:hidden">{data.dates.map(d=>{
    const totals=dayTotals(d,data.shifts);
    const weekday=new Date(d+"T12:00:00Z").getUTCDay();
    const opening=data.openHours?.[OPEN_HOURS_DAY_KEYS[weekday]];
    return <section key={d} id={"day-"+d} className="rounded-[20px] border border-line bg-surface p-3">
     <div className="flex flex-wrap items-baseline gap-2">
      <h2 className="text-lg font-bold">{dayLabel(d)}</h2>
      <span className="text-sm text-muted">{opening===undefined?t("hoursNotSet"):opening.length?t("open")+" "+opening.map(a=>a.join("–")).join(", "):t("closed")}</span>
      <strong className="ms-auto text-sm">{Number((totals.paidMinutes/60).toFixed(1))} h · {fmt(totals.knownCostCents,data.currency)}{totals.estimated?" "+t("estimated"):""}</strong>
     </div>
     <DayTimeline date={d} shifts={data.shifts} gaps={data.gaps} openHours={data.openHours} people={data.team}
      onShiftClick={data.readOnly?undefined:(id)=>openShift(d,id)}/>
     <div className="mt-3 flex flex-wrap gap-2">
      {data.gaps.filter(g=>g.date===d).map(g=><button disabled={data.readOnly} key={g.start}
       onClick={()=>fixGap(g)} className="min-h-12 flex-1 rounded-xl bg-neg-soft p-2 text-sm font-bold text-neg">
       ⚠ {g.start}–{g.end} · {t("fixGap",{count:g.headcount})}</button>)}
      <button disabled={data.readOnly} onClick={()=>openShift(d)} className="min-h-12 rounded-xl border-2 border-dashed border-line px-4 font-bold text-accent-text">{t("addShift")}</button>
     </div>
    </section>;
   })}</div>
   <WeekGrid dates={data.dates} people={data.team} shifts={data.shifts} gaps={data.gaps}
    openHours={data.openHours} currency={data.currency} readOnly={data.readOnly}
    onEdit={(d,id)=>openShift(d,id)} onAdd={(d,id)=>openShift(d,undefined,id)}/>
   {data.shifts.length===0&&<section className="rounded-2xl border border-line bg-surface p-5">
    <h2 className="font-headline text-xl font-bold">{t("noShifts")}</h2><p className="my-2 text-muted">{t("emptyHelp")}</p>
    <div className="grid gap-2 sm:grid-cols-3">
     <button disabled={data.readOnly||busy} className="min-h-12 rounded-xl border border-accent px-3 text-accent-text"
      onClick={()=>run(()=>copyWeek({fromWeekStart:new Date(Date.parse(data.weekStart+"T12:00:00Z")-7*86400000).toISOString().slice(0,10),toWeekStart:data.weekStart}))}>{t("copyLastWeek")}</button>
     <Link href={`/${locale}`} className="flex min-h-12 items-center justify-center rounded-xl border border-line px-3 text-accent-text" title={t("approvalComing")}>{t("askOlivia")}</Link>
     <button disabled={data.readOnly} className="min-h-12 rounded-xl bg-accent px-3 text-on-accent" onClick={()=>openShift(data.dates[0])}>{t("addShift")}</button>
    </div></section>}
   <div className="fixed inset-x-0 bottom-16 z-20 flex gap-2 border-t border-line bg-surface p-3 lg:bottom-0">
    <button disabled={busy||data.readOnly} className="min-h-14 flex-1 rounded-xl border border-accent text-accent-text" onClick={()=>run(()=>copyWeek({fromWeekStart:new Date(Date.parse(data.weekStart+"T12:00:00Z")-7*86400000).toISOString().slice(0,10),toWeekStart:data.weekStart}))}>{t("copyLastWeek")}</button>
    <button disabled={busy||data.readOnly} className="min-h-14 flex-1 rounded-xl bg-accent text-on-accent" onClick={()=>startTransition(async()=>{const r=await sendSchedule({weekStart:data.weekStart});if(!r.ok){setError(r.error);return;}setNotice(r.data.messages.map(m=>m.text).join("\n"));})}>{t("sendTeam")}</button>
   </div>
  </>:<>
   <section className="rounded-[20px] border border-line bg-surface p-4"><h2 className="text-lg font-bold">{t("addSomeone")}</h2>
     <div className="mt-3 flex gap-2"><input autoComplete="off" placeholder={t("name")} aria-label={t("newPersonName")}
       value={inlineName} onChange={e=>setInlineName(e.target.value)} disabled={data.readOnly}
       className="min-h-12 min-w-0 flex-1 rounded-xl border border-line bg-surface p-3"/>
       <button disabled={data.readOnly||busy||!inlineName.trim()} onClick={()=>run(async()=>{
        const response=await addPerson({name:inlineName.trim(),role:inlineRole,wageCents:null,
         availability:Array.from({length:7},(_,day)=>({day,start:null,end:null})),
         minWeeklyMinutes:null,maxWeeklyMinutes:null,phone:null});
        if(response.ok)setInlineName("");return response;
       })} className="min-h-12 rounded-xl bg-accent px-4 text-on-accent">{t("add")}</button></div>
     <div className="mt-2 flex flex-wrap gap-2">{["Barista","Manager","Baker","Cashier"].map(role=><button
      disabled={data.readOnly} key={role} onClick={()=>setInlineRole(role)} aria-pressed={inlineRole===role}
      className={`min-h-12 rounded-full border border-line px-3 text-sm ${inlineRole===role?"bg-accent-soft text-accent-text":""}`}>{roleLabel(role)}</button>)}</div>
     <button disabled={data.readOnly} onClick={()=>openPerson()} className="mt-3 min-h-12 w-full rounded-xl border-2 border-dashed border-accent text-accent-text">{t("moreDetails")}</button>
   </section>
   <section className="rounded-[20px] border border-line bg-surface p-4"><h2 className="mb-3 font-bold">{t("yourTeam",{count:data.team.length})}</h2>
     {data.team.map(p=><div key={p.id} className="flex min-h-16 items-center gap-3 border-t border-line py-3">
      <span className="grid size-12 place-items-center rounded-full bg-accent-soft font-bold">{p.name[0]}</span>
      <div className="min-w-0 flex-1"><b>{p.name}</b><span className="ms-2 text-sm text-muted">{p.role?roleLabel(p.role):t("team")}</span>
        <div className="text-sm text-muted">{p.wageCents==null?t("noWage"):fmt(p.wageCents,data.currency)+"/h"}</div></div>
      <div className="text-end">{hours(personTotals(p.id,data.shifts).paidMinutes)} h</div>
      <button disabled={data.readOnly} onClick={()=>openPerson(p)} className="min-h-12 px-2">{t("edit")}</button>
     </div>)}
     <div className="border-t border-line pt-3 font-bold">{t("total")} {fmt(data.total.knownCostCents,data.currency)} {data.total.estimated?" · "+t("estimate"):""}</div>
   </section>
   <Link href={`/${locale}/staff/rules`} className="block rounded-[20px] border border-line bg-surface p-4">{t("rulesCard")} <span className="block text-muted">{t("defaultNote")}</span></Link>
   {teamExtras}
  </>}
  {undo&&<div role="status" className="fixed inset-x-4 bottom-36 z-30 flex items-center justify-between rounded-xl bg-fg p-4 text-bg shadow-lg"><span>{undo.message}</span><button onClick={undoRemove} className="min-h-12 px-3 font-bold">{t("undo")}</button></div>}
  {error&&<p role="alert" className="rounded-xl bg-neg-soft p-3 text-neg">{error}</p>}
  {notice&&<div role="dialog" className="fixed inset-4 z-50 overflow-auto rounded-2xl bg-surface p-5 shadow-2xl"><h2>{t("readyCopy")}</h2><pre className="whitespace-pre-wrap">{notice}</pre><button onClick={()=>navigator.clipboard.writeText(notice)} className="my-3 min-h-12 rounded-xl bg-accent px-4 text-on-accent">{t("copy")}</button><button onClick={()=>setNotice("")} className="ms-3 min-h-12">{t("close")}</button></div>}
  {sheet&&<div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50" onClick={()=>setSheet(null)}>
   <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-5 pb-8" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true">
    <div className="mx-auto mb-3 h-1 w-12 rounded bg-line"/>{fillsGap&&sheet==="shift"&&<p className="text-sm font-bold text-pos">{t("fillsGap")}</p>}<h2 className="font-headline text-xl font-bold">{sheet==="person"?(personEditing?t("editPerson"):t("addPerson")):(editing?t("editShift"):t("addShiftDate",{date:dayLabel(date)}))}</h2>
    {sheet==="person"?<>
      <label className="mt-3 block font-semibold">{t("name")}<input value={name} onChange={e=>setName(e.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"/></label>
      <div className="mt-3 flex flex-wrap gap-2">{["Barista","Manager","Baker","Cashier"].map(r=><button key={r} aria-pressed={role===r} onClick={()=>setRole(r)} className="min-h-12 rounded-full border border-line px-3">{roleLabel(r)}</button>)}</div>
      <p className="mt-4 text-muted">{t("optional")}</p>
      {salaryPeriod?<p className="mt-3 rounded-xl bg-surface2 p-3 text-muted">{t("salaryManaged")}</p>:
      <label className="mt-3 block">{t("hourlyWage")}<div className="mt-2 flex items-center gap-4">
       <button className="min-h-12 min-w-12 rounded-xl bg-surface2" onClick={()=>setWage(Math.max(0,(wage??1900)-50))}>−</button>
       <strong>{wage==null?t("estimate"):fmt(wage,data.currency)}</strong>
       <button className="min-h-12 min-w-12 rounded-xl bg-surface2" onClick={()=>setWage((wage??1850)+50)}>+</button>
       <button onClick={()=>setWage(null)} className="min-h-12">{t("skip")}</button></div></label>}
      <div className="mt-4"><h3 className="font-bold">{t("usuallyAvailable")}</h3>
       <p className="text-sm text-muted">{t("availabilityHelp")}</p>
       {[0,1,2,3,4,5,6].map(day=>{const label=new Intl.DateTimeFormat(locale,{weekday:"short",timeZone:"UTC"}).format(new Date(Date.UTC(2026,9,25+day)));
        const row=availability.find(d=>d.day===day);
        return <div key={day} className="border-b border-line py-2">
         <div className="flex min-h-12 items-center gap-2">
          <button type="button" aria-pressed={Boolean(row)} onClick={()=>mutateAvailability(day,row?null:{start:null,end:null})}
           className={`min-h-12 min-w-14 rounded-xl px-3 ${row?"bg-accent text-on-accent":"bg-surface2 text-muted"}`}>{label}</button>
          <span className="flex-1 text-sm">{row?(row.start&&row.end?row.start+" – "+row.end:t("anyTime")):t("off")}</span>
          {row&&<button type="button" className="min-h-12 rounded-lg border border-line px-3" onClick={()=>mutateAvailability(day,row.start?{start:null,end:null}:{start:"06:00",end:"12:00"})}>
           {row.start?t("anyTime"):t("setHours")}</button>}
         </div>
         {row?.start&&row.end&&<div className="grid grid-cols-2 gap-2 pt-2">{(["start","end"] as const).map(field=>
          <div key={field} className="rounded-xl bg-surface2 p-2"><div className="text-sm">{field==="start"?t("from"):t("until")}</div>
           <div className="flex items-center justify-between gap-1">
            <button type="button" onClick={()=>mutateAvailability(day,{...row,[field]:timeStep(row[field]!, -30)})} className="min-h-12 min-w-10">−</button>
            <strong>{row[field]}</strong>
            <button type="button" onClick={()=>mutateAvailability(day,{...row,[field]:timeStep(row[field]!,30)})} className="min-h-12 min-w-10">+</button>
           </div></div>)}</div>}
        </div>;
       })}
      </div>
      {([[t("minimumWeek"),minWeeklyMinutes,setMinWeeklyMinutes],
         [t("maximumWeek"),maxWeeklyMinutes,setMaxWeeklyMinutes]] as const).map(([label,value,set])=>
       <div key={label} className="mt-3"><label className="font-semibold">{label} ({t("optionalShort")})</label>
         <div className="mt-1 flex items-center justify-between rounded-xl bg-surface2">
          <button type="button" className="min-h-12 min-w-12" onClick={()=>set(value===null?null:Math.max(0,value-60))}>−</button>
          <span>{value===null?t("notSet"):hours(value)+" h"}</span>
          <button type="button" className="min-h-12 min-w-12" onClick={()=>set((value??0)+60)}>+</button>
          <button type="button" className="min-h-12 px-2" onClick={()=>set(null)}>{t("clear")}</button>
         </div></div>)}
      <label className="mt-3 block font-semibold">{t("whatsapp")}
        <input type="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+14155551234"
         className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3" dir="ltr"/>
      </label>
      <button disabled={busy||!name.trim()} onClick={()=>run(()=>{
       const fields={name,role:role||null,wageCents:salaryPeriod?null:wage,availability,
        minWeeklyMinutes,maxWeeklyMinutes,phone:phone.trim()||null};
       return personEditing?updatePerson({id:personEditing,...fields}):addPerson(fields);
      })} className="mt-5 min-h-14 w-full rounded-xl bg-accent text-on-accent">
       {personEditing?t("saveChanges"):t("addNamed",{name:name.trim()})}</button>
      {personEditing&&<button disabled={busy} onClick={removePerson} className="mt-2 min-h-12 w-full text-neg">{t("removePerson")}</button>}
    </>:<>
      <div className="mt-3"><h3 className="font-bold">{t("who")}</h3><div className="mt-2 flex flex-wrap gap-2">{data.team.map(p=>{
       const status=availabilityStatus(p,date,start,end,data.shifts.filter(s=>s.id!==editing),data.availability);
       return <button key={p.id} type="button" aria-pressed={chosen===p.id} onClick={()=>setChosen(p.id)}
        className={`flex min-h-12 items-center gap-2 rounded-full border px-2 py-1 font-bold ${chosen===p.id?"border-accent-text bg-accent-soft text-accent-text":"border-line bg-surface"}`}>
        <span className="grid size-9 place-items-center rounded-full bg-surface2">{p.name[0]}</span>
        {p.name}<span className={`text-sm font-normal ${status==="free"?"text-pos":"text-muted"}`}>{t(status==="free"?"free":status==="off"?"off":status==="on_shift"?"onShift":"unavailable")}</span></button>;
      })}</div></div>
      {([[t("start"),start,setStart],[t("end"),end,setEnd]] as const).map(([label,time,set])=><div key={label} className="mt-3">
       <b>{label}</b><div className="flex items-center justify-between rounded-xl bg-surface2">
        <button onClick={()=>set(timeStep(time,-30))} className="min-h-12 min-w-12">−</button>
        <span>{time}</span>
        <button onClick={()=>set(timeStep(time,30))} className="min-h-12 min-w-12">+</button>
       </div></div>)}
      <p className="mt-2 text-center text-sm text-muted">{t("stepHint")}</p>
      <DayTimeline date={date} shifts={data.shifts} gaps={data.gaps} openHours={data.openHours}
       people={data.team} preview={previewBlock}/>
      <div className="mt-4 rounded-2xl border border-line p-3">
       <div className="flex min-h-14 items-center gap-2"><span aria-hidden="true">☕</span>
        <div className="flex-1"><strong>{t("unpaidBreak",{minutes:breakMin})}</strong><p className="text-sm text-muted">{t("autoBreak",{hours:data.rules.meal_break_after_minutes/60})}</p></div>
        <button type="button" onClick={()=>setBreakMin(Math.max(0,breakMin-10))} className="min-h-12 min-w-10">−</button>
        <button type="button" onClick={()=>setBreakMin(Math.min(240,breakMin+10))} className="min-h-12 min-w-10">+</button></div>
       <label className="flex min-h-14 items-center justify-between gap-3 border-t border-line">
        <span>{t("repeatEvery",{day:weekday(date,true)})}</span><input type="checkbox"
         checked={repeatWeekly} onChange={e=>setRepeatWeekly(e.target.checked)} className="size-6 accent-accent"/></label>
      </div>
      <ShiftPreview personId={chosen} date={date} start={start} end={end} breakMinutes={breakMin}
       editingId={editing} team={data.team} shifts={data.shifts} gaps={data.gaps}
       availability={data.availability} rules={data.rules} currency={data.currency} timezone={data.timezone}/>
      <button disabled={busy||!chosen} onClick={()=>run(()=>upsertShift({id:editing??undefined,employeeId:chosen,date,start,end,breakMinutes:breakMin,repeatWeekly}))}
       className="mt-5 min-h-14 w-full rounded-xl bg-accent text-on-accent">{t("saveShift")}</button>
      {editing&&<button className="mt-3 min-h-12 w-full text-neg" onClick={removeCurrentShift}>{t("removeShift")}</button>}
    </>}
    <button onClick={()=>setSheet(null)} className="mt-3 min-h-12 w-full">{t("cancel")}</button>
   </div></div>}
 </div>;
}
