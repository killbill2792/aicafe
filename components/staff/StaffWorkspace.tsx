"use client";
import {useEffect,useState,useTransition} from "react";
import {useRouter} from "next/navigation";
import OwnerScheduleSendPanel from "./OwnerScheduleSendPanel";
import {useTranslations} from "next-intl";
import {dismissStaffRuleAlert} from "@/lib/actions/ruleAlerts";
import DayTimeline from "./DayTimeline";
import StaffDialog from "./StaffDialog";
import WeekGrid from "./WeekGrid";
import ShiftPreview from "./ShiftPreview";
import {dayTotals,personTotals,bestFreePerson,availabilityStatus,totalOvertimeMinutes,previewShift,type DetailedShift} from "@/lib/calc/scheduling/schedulePresentation";
import {OPEN_HOURS_DAY_KEYS} from "@/lib/business/openHours";
import {uncheckedCoverageDays,coverageVerification} from "@/lib/calc/scheduling/coverageGaps";
import {automaticUnpaidBreakMinutes} from "@/lib/calc/scheduling/ruleChecks";
import {costCompleteness} from "@/lib/calc/scheduling/shiftCost";
import Link from "next/link";
import {parseHourlyWage,parseWeeklyHours,weeklyHoursInput,isValidTeamAvailability,teamAvailabilitySummary,formatTeamClock} from "./teamPersonFields";
import {addPerson,updatePerson,setPersonActive} from "@/lib/actions/teamWorkspace";
import {upsertShift,removeShift,restoreShift,copyWeek,sendSchedule} from "@/lib/actions/schedule";
type Data=Extract<Awaited<ReturnType<typeof import("@/lib/actions/schedule").getWeekSchedule>>,{ok:true}>["data"];
const fmt=(c:number|null,currency:string,locale?:string)=>c==null?"—":new Intl.NumberFormat(locale,{style:"currency",currency}).format(c/100);
const wageEdit=(c:number,locale:string)=>new Intl.NumberFormat(locale,{useGrouping:false,minimumFractionDigits:2,maximumFractionDigits:2}).format(c/100);
const hours=(n:number)=>Number((n/60).toFixed(1));
type Alert={id:string;employee_id:string;rule_key:string;message:string;created_at:string};
export default function StaffWorkspace({initial,tab="schedule",locale="en",initialAlerts=[],alertError=null,teamExtras=null}:{
 initial:Data;tab?:string;locale?:string;initialAlerts?:Alert[];alertError?:string|null;teamExtras?:React.ReactNode
}){
 const router=useRouter();const t=useTranslations("StaffSchedule");
 const wageSummary=(value:{knownCostCents:number;unknownCount:number})=>{
  const status=costCompleteness(value);
  return status==="unknown"?t("unknownWages"):
   status==="partial"?t("partialWages",{known:fmt(value.knownCostCents,data.currency,locale),count:value.unknownCount}):
   fmt(value.knownCostCents,data.currency,locale);
 };
 const roleLabel=(v:string)=>({Barista:t("roleBarista"),Manager:t("roleManager"),Baker:t("roleBaker"),Cashier:t("roleCashier")}[v]??v);
 const [version,setVersion]=useState({initial,local:initial});
 const data=version.initial===initial?version.local:initial;
 const setData=(value:Data)=>setVersion({initial,local:value});
 const uncheckedDays=uncheckedCoverageDays(data.dates,data.openHours,data.rules.coverage_enabled);
 const [screen,setScreen]=useState(tab),[sheet,setSheet]=useState<"person"|"shift"|null>(null);
 const [busy,startTransition]=useTransition(),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [savingConsent,setSavingConsent]=useState(false),[consentError,setConsentError]=useState(false);
 const [dismissed,setDismissed]=useState<string[]>([]);
 const [repeatWeekly,setRepeatWeekly]=useState(false),[fillsGap,setFillsGap]=useState(false),[breakOverridden,setBreakOverridden]=useState(false);
 const [inlineName,setInlineName]=useState(""),[inlineRole,setInlineRole]=useState("Barista");
 const [name,setName]=useState(""),[role,setRole]=useState("Barista"),[wageInput,setWageInput]=useState(""),[focusWage,setFocusWage]=useState(false);
  const [minHoursInput,setMinHoursInput]=useState(""),[maxHoursInput,setMaxHoursInput]=useState(""),[confirmRemoval,setConfirmRemoval]=useState(false);
  const wage=parseHourlyWage(wageInput),minHours=parseWeeklyHours(minHoursInput),maxHours=parseWeeklyHours(maxHoursInput);
  const invalidWage=wage===undefined,invalidMin=minHours===undefined,invalidMax=maxHours===undefined;
  const invalidRange=minHours!=null&&maxHours!=null&&minHours>maxHours;
 const [phone,setPhone]=useState(""),[whatsAppOptIn,setWhatsAppOptIn]=useState(false),[salaryPeriod,setSalaryPeriod]=useState<string|null>(null),[personEditing,setPersonEditing]=useState<string|null>(null);
 const [chosen,setChosen]=useState(data.team[0]?.id??""),[date,setDate]=useState(data.dates[0]);
 const [start,setStart]=useState("07:00"),[end,setEnd]=useState("15:00"),[breakMin,setBreakMin]=useState(30);
 const [editing,setEditing]=useState<string|null>(null),
 [availability,setAvailability]=useState<{day:number;start:string|null;end:string|null}[]>([]),
 [availabilityDirty,setAvailabilityDirty]=useState(false);
 const invalidAvailability=!isValidTeamAvailability(availability);
 const personInvalid=(!salaryPeriod&&invalidWage)||invalidMin||invalidMax||invalidRange||invalidAvailability;
 const [undo,setUndo]=useState<{id:string;type:"person"|"shift";message:string}|null>(null);
 useEffect(()=>{if(!undo)return;const timer=setTimeout(()=>setUndo(null),6000);return ()=>clearTimeout(timer);},[undo]);
 const allDays=()=>Array.from({length:7},(_,day)=>({day,start:null,end:null}));
 const run=(fn:()=>Promise<{ok:boolean;error?:string}>)=>startTransition(async()=>{
  setError("");const res=await fn();
  if(!res.ok){setError(res.error??"Could not save");router.refresh();return;}
  setSheet(null);router.refresh();
 });
 const openPerson=(person?:Data["team"][number])=>{
  setAvailabilityDirty(false);setConsentError(false);setConfirmRemoval(false);setFocusWage(false);
  setPersonEditing(person?.id??null);setName(person?.name??"");setRole(person?.role??"Barista");
  setWageInput(person?.wageCents==null?"":wageEdit(person.wageCents,locale));setSalaryPeriod(person?.wagePeriod&&person.wagePeriod!=="hour"?person.wagePeriod:null);
  setPhone(person?.phone??"");setWhatsAppOptIn(person?.whatsappOptIn??false);
   setMinHoursInput(weeklyHoursInput(person?.minWeeklyMinutes??null,locale));setMaxHoursInput(weeklyHoursInput(person?.maxWeeklyMinutes??null,locale));
  if(person){
   const days=person.availableDays??[0,1,2,3,4,5,6];
   setAvailability(days.map(day=>{
    const candidate=data.profileAvailability.filter(a=>a.employee_id===person.id&&a.day_of_week===day)
     .sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
    return {day,start:candidate?String(candidate.start_local).slice(0,5):null,
      end:candidate?String(candidate.end_local).slice(0,5):null};
   }));
  }else setAvailability(allDays());
  setSheet("person");
 };
 // An explicit owner action persists immediately; don't toggle the visible
 // consent checkbox until the protected PATCH completes successfully.
 const saveConsent=async(next:boolean)=>{
  if(!personEditing||savingConsent||busy||data.readOnly)return;
  setSavingConsent(true);setConsentError(false);setError("");
  try{
   const response=await fetch("/api/staff/schedule-delivery",{
    method:"PATCH",credentials:"same-origin",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({employeeId:personEditing,whatsappOptIn:next})
   });
   if(!response.ok)throw new Error("consent");
   setWhatsAppOptIn(next);
   setData({...data,team:data.team.map(person=>person.id===personEditing?
     {...person,whatsappOptIn:next}:person)});
   router.refresh();
  }catch{setConsentError(true);}
  finally{setSavingConsent(false);}
 };
 const mutateAvailability=(day:number,update:{start:string|null;end:string|null}|null)=>{
  setAvailabilityDirty(true);
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
  const firstOpen=data.openHours?.[OPEN_HOURS_DAY_KEYS[new Date(d+"T12:00:00Z").getUTCDay()]]?.[0];
  setStart(shift?.start??firstOpen?.[0]??"07:00");
  setEnd(shift?.end??firstOpen?.[1]??"15:00");
  setBreakOverridden(shift?.breakSource==="owner");
  setBreakMin(shift?.breakMinutes??0);setSheet("shift");
 };
 const removePerson=()=>{if(!personEditing||!confirmRemoval)return;const id=personEditing,label=name;
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
  const civilDate=gap.shiftDate??gap.date;
  const person=bestFreePerson(data.team,civilDate,gap.start,gap.end,[...data.shifts,...data.adjacentShifts],data.availability);
  openShift(civilDate,undefined,person?.id);
  setStart(gap.start);setEnd(gap.end);
  setBreakOverridden(false);
  setFillsGap(true);
 };
 const appliedBreak=breakOverridden?breakMin:automaticUnpaidBreakMinutes(start,end,data.rules);
 const proposed=sheet==="shift"?previewShift({employeeId:chosen,date,start,end,breakMinutes:appliedBreak,editingId:editing},
  data.team,data.shifts,data.gaps,data.availability,data.rules,data.timezone,data.adjacentShifts):null;
 const previewBlock:DetailedShift|null=proposed?{...proposed.next,id:editing??"preview",
  employeeName:data.team.find(p=>p.id===chosen)?.name??t("team"),status:"draft"}:null;
 const availabilityWords={anyTime:t("anyTime"),off:t("off"),none:t("noAvailableDays"),everyDay:t("everyDay")};
 const teamSummary=(p:Data["team"][number])=>teamAvailabilitySummary((p.availableDays??[0,1,2,3,4,5,6]).map(day=>{
  const match=data.profileAvailability.filter(a=>a.employee_id===p.id&&a.day_of_week===day).sort((a,b)=>b.effective_from.localeCompare(a.effective_from))[0];
  return {day,start:match?String(match.start_local).slice(0,5):null,end:match?String(match.end_local).slice(0,5):null};
 }),locale,availabilityWords);
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
    [t("wages"),wageSummary(data.total)],
    [t("gaps"),!data.rules.coverage_enabled?t("coverageDisabled"):uncheckedDays.length?
   t("coverageNotChecked"):String(data.gaps.length)],
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
      <strong className="ms-auto text-sm">{Number((totals.paidMinutes/60).toFixed(1))} h · {wageSummary(totals)}{totals.estimated?" "+t("estimated"):""}</strong>
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
   <WeekGrid dates={data.dates} people={data.displayTeam} shifts={data.shifts} gaps={data.gaps}
    openHours={data.openHours} currency={data.currency} readOnly={data.readOnly} coverageEnabled={data.rules.coverage_enabled}
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
    <button disabled={busy||data.readOnly} className="min-h-14 flex-1 rounded-xl bg-accent text-on-accent" onClick={()=>startTransition(async()=>{const r=await sendSchedule({weekStart:data.weekStart});if(!r.ok){setError(r.error);return;}setNotice(r.data.messages.map(m=>m.text).join("\n"));})}>{t("prepareScheduleMessages")}</button>
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
        <div className="text-[17px] text-muted">{p.wageCents==null?(p.wagePeriod!=="hour"?t("salaryManagedBadge"):<button type="button" disabled={data.readOnly} onClick={()=>{openPerson(p);setFocusWage(true);}} className="min-h-12 text-start underline text-accent-text">{t("noWageAction")}</button>):t("wagePerHour",{amount:fmt(p.wageCents,data.currency,locale)})}</div><div className="text-[17px] text-muted">{teamSummary(p)}</div></div>
      <div className="text-end">{t("teamHoursShort",{hours:new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(hours(personTotals(p.id,data.shifts).paidMinutes))})}</div>
      <button disabled={data.readOnly} onClick={()=>openPerson(p)} className="min-h-12 px-2">{t("edit")}</button>
     </div>)}
     <div className="border-t border-line pt-3 font-bold">{t("total")} {wageSummary(data.total)} {data.total.estimated?" · "+t("estimate"):""}</div>
   </section>
   <Link href={`/${locale}/staff/rules`} className="block rounded-[20px] border border-line bg-surface p-4">{t("rulesCard")} <span className="block text-muted">{t("defaultNote")}</span></Link>
   {teamExtras}
  </>}
  {undo&&<div role="status" className="fixed inset-x-4 bottom-36 z-30 flex items-center justify-between rounded-xl bg-fg p-4 text-bg shadow-lg"><span>{undo.message}</span><button onClick={undoRemove} className="min-h-12 px-3 font-bold">{t("undo")}</button></div>}
  {error&&<p role="alert" className="rounded-xl bg-neg-soft p-3 text-neg">{error}</p>}
  {notice&&<StaffDialog headingId="staff-copy-heading" layout="center" onClose={()=>setNotice("")}><h2 id="staff-copy-heading">{t("readyCopy")}</h2><p role="status" className="mt-2 text-muted">{t("scheduleNotSent")}</p><pre className="whitespace-pre-wrap">{notice}</pre><button onClick={()=>navigator.clipboard.writeText(notice)} className="my-3 min-h-12 rounded-xl bg-accent px-4 text-on-accent">{t("copy")}</button><button onClick={()=>setNotice("")} className="ms-3 min-h-12">{t("close")}</button></StaffDialog>}
  {sheet&&<StaffDialog headingId="staff-sheet-heading" onClose={()=>setSheet(null)}>
    <div className="mx-auto mb-3 h-1 w-12 rounded bg-line"/>{fillsGap&&sheet==="shift"&&<p className="text-sm font-bold text-pos">{t("fillsGap")}</p>}<h2 id="staff-sheet-heading" className="font-headline text-xl font-bold">{sheet==="person"?(personEditing?t("editPerson"):t("addPerson")):(editing?t("editShift"):t("addShiftDate",{date:dayLabel(date)}))}</h2>
    {sheet==="person"?<>
      <label className="mt-3 block font-semibold">{t("name")}<input autoFocus={sheet==="person"&&!focusWage} value={name} onChange={e=>setName(e.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"/></label>
      <div className="mt-3 flex flex-wrap gap-2">{["Barista","Manager","Baker","Cashier"].map(r=><button type="button" key={r} aria-pressed={role===r} onClick={()=>setRole(r)} className="min-h-12 rounded-full border border-line px-3">{roleLabel(r)}</button>)}<button type="button" aria-pressed={!["Barista","Manager","Baker","Cashier"].includes(role)} onClick={()=>setRole("")} className="min-h-12 rounded-full border border-line px-3">{t("roleOther")}</button></div>
      {!["Barista","Manager","Baker","Cashier"].includes(role)&&<label className="mt-2 block">{t("roleOther")}<input maxLength={60} value={role} onChange={e=>setRole(e.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"/></label>}
      <p className="mt-4 text-muted">{t("optional")}</p>
      {salaryPeriod?<p className="mt-3 rounded-xl bg-surface2 p-3 text-muted">{t("salaryManaged")}</p>:
      <div className="mt-3"><label htmlFor="staff-hourly-wage" className="font-semibold">{t("hourlyWage")}</label>
       <div className="mt-2 flex items-center gap-2"><input id="staff-hourly-wage" autoFocus={focusWage} inputMode="decimal" dir="ltr" value={wageInput} onChange={e=>setWageInput(e.target.value)}
        aria-invalid={invalidWage} aria-describedby={invalidWage?"staff-wage-error":undefined}
        placeholder={wageEdit(1873,locale)} className={`min-h-12 min-w-0 flex-1 rounded-xl border bg-surface px-3 ${invalidWage?"border-neg ring-1 ring-neg":"border-line"}`}/>
        <button type="button" className="min-h-12 rounded-xl border border-line px-3" onClick={()=>setWageInput("")}>{t("notSureYet")}</button></div>
       {invalidWage&&<p id="staff-wage-error" role="alert" className="mt-1 text-sm text-neg">{t("invalidWage")}</p>}
      </div>}
      <div className="mt-4"><h3 className="font-bold">{t("usuallyAvailable")}</h3>
       <p className="text-sm text-muted">{t("availabilityHelp")}</p>
       {[0,1,2,3,4,5,6].map(day=>{const label=new Intl.DateTimeFormat(locale,{weekday:"short",timeZone:"UTC"}).format(new Date(Date.UTC(2026,9,25+day)));
        const row=availability.find(d=>d.day===day);
        return <div key={day} className="border-b border-line py-2">
         <div className="flex min-h-12 items-center gap-2">
          <button type="button" aria-pressed={Boolean(row)} onClick={()=>mutateAvailability(day,row?null:{start:null,end:null})}
           className={`min-h-12 min-w-14 rounded-xl px-3 ${row?"bg-accent text-on-accent":"bg-surface2 text-muted"}`}>{label}</button>
          <span className="flex-1 text-sm">{row?(row.start&&row.end?formatTeamClock(row.start,locale)+" – "+formatTeamClock(row.end,locale):t("anyTime")):t("off")}</span>
         </div>
         {row&&<div className="mt-2 flex flex-wrap gap-2">{(["morning","afternoon","allDay"] as const).map(chip=><button type="button" key={chip}
          onClick={()=>mutateAvailability(day,chip==="allDay"?{start:null,end:null}:chip==="morning"?{start:"06:00",end:"12:00"}:{start:"12:00",end:"18:00"})}
          aria-pressed={chip==="allDay"?row.start===null&&row.end===null:chip==="morning"?row.start==="06:00"&&row.end==="12:00":row.start==="12:00"&&row.end==="18:00"}
           className="min-h-12 rounded-full border border-line px-3 text-[17px]">{t(chip)}</button>)}</div>}
         {row&&<div className="mt-2 grid grid-cols-2 gap-2">{(["start","end"] as const).map(field=><label key={field} className="text-sm">
          {field==="start"?t("from"):t("until")}
          <input type="time" step={60} value={row[field]??""} onChange={e=>mutateAvailability(day,{...row,[field]:e.target.value||null})}
           aria-invalid={Boolean((row.start===null)!==(row.end===null)||row.start&&row.start===row.end)}
           aria-describedby={invalidAvailability?"staff-availability-error":undefined}
            className={`mt-1 min-h-12 w-full rounded-xl border bg-surface px-2 ${invalidAvailability?"border-neg":"border-line"}`} dir="ltr"/>
         </label>)}</div>}
        </div>;
       })}
      </div>
      {invalidAvailability&&<p id="staff-availability-error" role="alert" className="mt-2 text-[17px] text-neg">{t("invalidAvailability")}</p>}
      {([[t("minimumWeek"),minHoursInput,setMinHoursInput,invalidMin],[t("maximumWeek"),maxHoursInput,setMaxHoursInput,invalidMax||invalidRange]] as const).map(([label,value,set,invalid])=>
       <div key={label} className="mt-3"><label className="font-semibold">{label} ({t("optionalShort")})
        <input inputMode="decimal" dir="ltr" value={value} onChange={e=>set(e.target.value)} aria-invalid={invalid}
         className={`mt-1 min-h-12 w-full rounded-xl border bg-surface px-3 ${invalid?"border-neg ring-1 ring-neg":"border-line"}`} placeholder="25"/>
       </label>{invalid&&<p role="alert" className="mt-1 text-sm text-neg">{invalidRange?t("invalidWeeklyRange"):t("invalidWeeklyHours")}</p>}</div>)}
      <label className="mt-3 block font-semibold">{t("whatsapp")}
        <input type="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+14155551234"
         className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3" dir="ltr"/>
      </label>
      {personEditing?<label className="mt-3 flex min-h-12 items-center gap-3 rounded-xl border border-line p-3">
        <input type="checkbox" checked={whatsAppOptIn}
          disabled={savingConsent||busy||data.readOnly}
          onChange={event=>void saveConsent(event.target.checked)}
          className="size-6 shrink-0 accent-accent"/>
        <span className="text-[17px]">{t("deliveryConsent")}</span>
       </label>:<p className="mt-3 text-sm text-muted">{t("deliveryConsentAfterCreate")}</p>}
       {personEditing&&consentError&&<p role="alert" className="mt-2 text-neg">{t("deliveryConsentError")}</p>}
       <button disabled={busy||savingConsent||!name.trim()||personInvalid} onClick={()=>run(()=>{
       const fields={name,role:role||null,wageCents:salaryPeriod?null:wage??null,availability:personEditing&&!availabilityDirty?null:availability,
        minWeeklyMinutes:minHours??null,maxWeeklyMinutes:maxHours??null,phone:phone.trim()||null};
       return personEditing?updatePerson({id:personEditing,...fields}):addPerson(fields);
      })} className="mt-5 min-h-14 w-full rounded-xl bg-accent text-on-accent">
       {personEditing?t("saveChanges"):t("addNamed",{name:name.trim()})}</button>
      {personEditing&&(!confirmRemoval?<button type="button" disabled={busy} onClick={()=>setConfirmRemoval(true)} className="mt-2 min-h-12 w-full text-neg">{t("removePerson")}</button>:<div className="mt-2 rounded-xl border border-neg p-3"><p>{t("confirmRemovePerson",{name})}</p><div className="mt-2 flex gap-2"><button type="button" disabled={busy} onClick={removePerson} className="min-h-12 flex-1 rounded-xl bg-neg px-3 text-white">{t("confirmRemove")}</button><button type="button" onClick={()=>setConfirmRemoval(false)} className="min-h-12 flex-1 rounded-xl border border-line px-3">{t("cancel")}</button></div></div>)}
    </>:<>
      <div className="mt-3"><h3 className="font-bold">{t("who")}</h3><div className="mt-2 flex flex-wrap gap-2">{data.team.map(p=>{
       const status=availabilityStatus(p,date,start,end,[...data.shifts.filter(s=>s.id!==editing),...data.adjacentShifts],data.availability);
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
        <div className="flex-1"><strong>{t("unpaidBreak",{minutes:appliedBreak})}</strong><p className="text-sm text-muted">{breakOverridden?t("breakManual"):data.rules.meal_break_enabled?
   t("autoBreak",{hours:data.rules.meal_break_after_minutes/60}):t("breakDisabled")}</p></div>
        <button type="button" onClick={()=>{setBreakOverridden(true);setBreakMin(Math.max(0,appliedBreak-10));}} className="min-h-12 min-w-10">−</button>
        <button type="button" onClick={()=>{setBreakOverridden(true);setBreakMin(Math.min(240,appliedBreak+10));}} className="min-h-12 min-w-10">+</button></div>
       <label className="flex min-h-14 items-center justify-between gap-3 border-t border-line">
        <span>{t("repeatEvery",{day:weekday(date,true)})}</span><input type="checkbox"
         checked={repeatWeekly} onChange={e=>setRepeatWeekly(e.target.checked)} className="size-6 accent-accent"/></label>
      </div>
      <ShiftPreview personId={chosen} date={date} start={start} end={end} breakMinutes={appliedBreak}
       editingId={editing} team={data.team} shifts={data.shifts} gaps={data.gaps}
       availability={data.availability} boundaryShifts={data.adjacentShifts} coverageChecked={coverageVerification(date,data.openHours,data.rules.coverage_enabled)==="checked"} rules={data.rules} currency={data.currency} timezone={data.timezone}/>
      <button disabled={busy||!chosen} onClick={()=>run(()=>upsertShift({id:editing??undefined,employeeId:chosen,date,start,end,breakMinutes:breakOverridden?breakMin:undefined,repeatWeekly}))}
       className="mt-5 min-h-14 w-full rounded-xl bg-accent text-on-accent">{t("saveShift")}</button>
      {editing&&<button className="mt-3 min-h-12 w-full text-neg" onClick={removeCurrentShift}>{t("removeShift")}</button>}
    </>}
    <button onClick={()=>setSheet(null)} className="mt-3 min-h-12 w-full">{t("cancel")}</button>
   </StaffDialog>}
 </div>;
}
