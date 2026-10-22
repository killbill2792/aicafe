"use client";
import {useEffect,useState,useTransition} from "react";
import {useRouter} from "next/navigation";
import {dismissStaffRuleAlert} from "@/lib/actions/ruleAlerts";
import Link from "next/link";
import {addPerson,updatePerson,setPersonActive} from "@/lib/actions/teamWorkspace";
import {upsertShift,removeShift,restoreShift,copyWeek,sendSchedule} from "@/lib/actions/schedule";
type Data=Extract<Awaited<ReturnType<typeof import("@/lib/actions/schedule").getWeekSchedule>>,{ok:true}>["data"];
const fmt=(c:number|null,currency:string)=>c==null?"—":new Intl.NumberFormat(undefined,{style:"currency",currency}).format(c/100);
const hours=(n:number)=>Number((n/60).toFixed(1));
type Alert={id:string;employee_id:string;rule_key:string;message:string;created_at:string};
export default function StaffWorkspace({initial,tab="schedule",locale="en",initialAlerts=[],alertError=null}:{
 initial:Data;tab?:string;locale?:string;initialAlerts?:Alert[];alertError?:string|null
}){
 const router=useRouter();
 const [version,setVersion]=useState({initial,local:initial});
 const data=version.initial===initial?version.local:initial;
 const setData=(value:Data)=>setVersion({initial,local:value});
 const [screen,setScreen]=useState(tab),[sheet,setSheet]=useState<"person"|"shift"|null>(null);
 const [busy,startTransition]=useTransition(),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [dismissed,setDismissed]=useState<string[]>([]);
 const [name,setName]=useState(""),[role,setRole]=useState("Barista"),[wage,setWage]=useState<number|null>(null);
 const [phone,setPhone]=useState(""),[minWeeklyMinutes,setMinWeeklyMinutes]=useState<number|null>(null),
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
  setWage(person?.wageCents??null);setPhone(person?.phone??"");
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
  const shift=data.shifts.find(s=>s.id===id);setDate(d);setEditing(id??null);
  setChosen(shift?.employeeId??employeeId??data.team[0]?.id??"");
  setStart(shift?.start??"07:00");setEnd(shift?.end??"15:00");setBreakMin(shift?.breakMinutes??30);setSheet("shift");
 };
 const removePerson=()=>{if(!personEditing)return;const id=personEditing,label=name;
  setData({...data,team:data.team.filter(p=>p.id!==id)});
  setUndo({id,type:"person",message:label+" removed from team"});
  setSheet(null);run(()=>setPersonActive({id,active:false}));
 };
 const removeCurrentShift=()=>{if(!editing)return;const id=editing;
  setData({...data,shifts:data.shifts.filter(s=>s.id!==id)});
  setUndo({id,type:"shift",message:"Shift removed"});setSheet(null);run(()=>removeShift({id}));
 };
 const undoRemove=()=>{if(!undo)return;const item=undo;setUndo(null);
  run(()=>item.type==="shift"?restoreShift({id:item.id}):setPersonActive({id:item.id,active:true}));
 };
 const dayLabel=(d:string)=>new Intl.DateTimeFormat(locale,{weekday:"short",day:"numeric",timeZone:"UTC"}).format(new Date(d+"T12:00:00Z"));
 const status=data.shifts.some(s=>s.status==="sent")?"Sent":"Draft";
 return <div className="mx-auto w-full max-w-7xl space-y-3 px-4 pb-32 pt-5 text-fg" dir={locale==="ar"?"rtl":"ltr"}>
  <header className="flex items-center justify-between gap-3"><h1 className="font-headline text-2xl font-extrabold">Schedule</h1>
   <div className="flex gap-2"><Link className="flex min-h-12 items-center rounded-full border border-line px-4" href={`/${locale}/staff/rules`}>⚙ Rules</Link><button disabled={data.readOnly} aria-label="Add shift" onClick={()=>openShift(date)} className="min-h-12 min-w-12 rounded-full bg-accent text-on-accent">+</button></div>
  </header>
  {data.readOnly&&<p className="rounded-xl bg-surface2 p-3 text-muted">Read-only schedule · editing is available to the café owner</p>}
  <div className="grid grid-cols-2 rounded-2xl bg-surface2 p-1">{["schedule","team"].map(k=><button key={k} onClick={()=>setScreen(k)} aria-pressed={screen===k}
    className={`min-h-12 rounded-xl font-bold ${screen===k?"bg-surface shadow":"text-muted"}`}>{k==="schedule"?"Schedule":"Team"}</button>)}</div>
  {screen==="schedule"?<>
   {alertError&&<p role="alert" className="rounded-xl bg-warn-soft p-3 text-warn-text">Rule alerts could not be refreshed: {alertError}</p>}
   {initialAlerts.filter(a=>!dismissed.includes(a.id)).length>0&&<section className="rounded-2xl border border-line bg-surface p-4">
    <h2 className="text-lg font-bold">Rule alerts · {initialAlerts.filter(a=>!dismissed.includes(a.id)).length}</h2>
    {initialAlerts.filter(a=>!dismissed.includes(a.id)).map(a=><div key={a.id} className="flex items-start gap-3 border-t border-line py-3">
      <span aria-hidden="true">⚠</span><div className="min-w-0 flex-1"><p className="font-semibold">{a.rule_key.replaceAll("_"," ")}</p><p className="text-sm text-muted">{a.message}</p></div>
      <button disabled={busy} className="min-h-12 rounded-lg border border-line px-3" onClick={()=>{setDismissed(ids=>[...ids,a.id]);run(()=>dismissStaffRuleAlert({id:a.id}));}}>Dismiss</button>
    </div>)}
   </section>}
   <div className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-surface p-3">
    <Link href={`?week=${new Date(Date.parse(data.weekStart+"T12:00:00Z")-7*86400000).toISOString().slice(0,10)}`} className="p-3">‹</Link>
    <div className="text-center font-semibold">{dayLabel(data.dates[0])} – {dayLabel(data.dates[6])}<div className="text-sm text-muted">{status}</div></div>
    <Link href={`?week=${new Date(Date.parse(data.weekStart+"T12:00:00Z")+7*86400000).toISOString().slice(0,10)}`} className="p-3">›</Link>
   </div>
   <div className="grid grid-cols-3 gap-2">{[
    ["Paid hours",String(hours(data.total.paidMinutes))],
    ["Wages",fmt(data.total.knownCostCents,data.currency)],
    ["Gaps",String(data.gaps.length)]
   ].map(([label,value])=><div key={label} className="rounded-2xl border border-line bg-surface p-3"><strong className="block text-xl">{value}</strong><span className="text-sm text-muted">{label}</span></div>)}</div>
   {data.total.estimated&&<p className="rounded-xl bg-warn-soft p-3 text-warn-text">Estimate: {data.total.estimateCount} estimated shift(s), {data.total.unknownCount} without an available wage estimate.</p>}
   <nav aria-label="Week days" className="grid grid-cols-7 gap-1">{data.dates.map(d=><a key={d} href={"#day-"+d} className="rounded-xl bg-surface2 px-1 py-3 text-center text-sm">{dayLabel(d)}{data.gaps.some(g=>g.date===d)&&<span className="block text-neg">●</span>}</a>)}</nav>
   <div className="space-y-3 lg:hidden">{data.dates.map(d=><section key={d} id={"day-"+d} className="rounded-[20px] border border-line bg-surface p-4">
    <div className="flex items-center justify-between gap-2"><h2 className="text-lg font-bold">{dayLabel(d)}</h2>
      <strong>{hours(data.shifts.filter(s=>s.date===d).reduce((n,s)=>n+s.paidMinutes,0))} h</strong></div>
    <div className="mt-3 space-y-2">{data.shifts.filter(s=>s.date===d).map(s=><button key={s.id} onClick={()=>openShift(d,s.id)}
      className="flex min-h-12 w-full items-center justify-between rounded-xl bg-accent-soft px-3 text-start text-accent-text">
      <span>{s.employeeName} · {s.start}–{s.end}</span><span>{hours(s.paidMinutes)} h · {fmt(s.costCents,data.currency)}{s.estimated?" est.":""}</span>
    </button>)}</div>
    {data.gaps.filter(g=>g.date===d).map(g=><button key={g.start} disabled={data.readOnly} onClick={()=>openShift(d)}
      className="mt-2 flex min-h-12 w-full items-center justify-between rounded-xl bg-neg-soft px-3 text-neg">
      ⚠ {g.start}–{g.end} · {g.headcount} on <b>Fix</b></button>)}
    <button disabled={data.readOnly} onClick={()=>openShift(d)} className="mt-3 min-h-12 w-full rounded-xl border-2 border-dashed border-line text-accent-text">+ shift</button>
   </section>)}</div>
   <div className="hidden overflow-x-auto rounded-[20px] border border-line bg-surface lg:block"><table className="w-full min-w-[920px] text-start">
    <thead><tr><th className="p-3 text-start">Team</th>{data.dates.map(d=><th key={d} className="p-3">{dayLabel(d)}</th>)}<th>Week</th></tr></thead>
    <tbody>{data.team.map(p=><tr key={p.id} className="border-t border-line"><th className="p-3 text-start">{p.name}<small className="block text-muted">{p.role??"Team"}</small></th>
      {data.dates.map(d=><td key={d} className="p-2">{data.shifts.filter(s=>s.date===d&&s.employeeId===p.id).map(s=><button key={s.id} onClick={()=>openShift(d,s.id)} className="block w-full rounded-lg bg-accent-soft p-2 text-sm text-accent-text">{s.start}–{s.end}<span className="block">{hours(s.paidMinutes)} h</span></button>)}<button disabled={data.readOnly} onClick={()=>openShift(d,undefined,p.id)} className="min-h-12 w-full text-muted">+</button></td>)}
      <td className="p-2 text-center">{hours(data.shifts.filter(s=>s.employeeId===p.id).reduce((n,s)=>n+s.paidMinutes,0))} h</td>
    </tr>)}</tbody>
    <tfoot><tr><th className="p-3">Coverage</th>{data.dates.map(d=><td key={d} className="p-2 text-sm">{data.gaps.some(g=>g.date===d)?"⚠ Gap":"✓"}</td>)}<td /></tr></tfoot>
   </table></div>
   {data.shifts.length===0&&<p className="rounded-2xl border border-line bg-surface p-5">No shifts this week. Copy last week or add a shift.</p>}
   <div className="fixed inset-x-0 bottom-16 z-20 flex gap-2 border-t border-line bg-surface p-3 lg:bottom-0">
    <button disabled={busy||data.readOnly} className="min-h-14 flex-1 rounded-xl border border-accent text-accent-text" onClick={()=>run(()=>copyWeek({fromWeekStart:new Date(Date.parse(data.weekStart+"T12:00:00Z")-7*86400000).toISOString().slice(0,10),toWeekStart:data.weekStart}))}>Copy last week</button>
    <button disabled={busy} className="min-h-14 flex-1 rounded-xl bg-accent text-on-accent" onClick={()=>startTransition(async()=>{const r=await sendSchedule({weekStart:data.weekStart});if(!r.ok){setError(r.error);return;}setNotice(r.data.messages.map(m=>m.text).join("\n"));})}>Send to team</button>
   </div>
  </>:<>
   <section className="rounded-[20px] border border-line bg-surface p-4"><h2 className="text-lg font-bold">Add someone</h2>
     <button disabled={data.readOnly} onClick={()=>openPerson()} className="mt-3 min-h-12 w-full rounded-xl border-2 border-dashed border-accent text-accent-text">+ Add person</button></section>
   <section className="rounded-[20px] border border-line bg-surface p-4"><h2 className="mb-3 font-bold">Your team · {data.team.length}</h2>
     {data.team.map(p=><div key={p.id} className="flex min-h-16 items-center gap-3 border-t border-line py-3">
      <span className="grid size-12 place-items-center rounded-full bg-accent-soft font-bold">{p.name[0]}</span>
      <div className="min-w-0 flex-1"><b>{p.name}</b><span className="ms-2 text-sm text-muted">{p.role}</span>
        <div className="text-sm text-muted">{p.wageCents==null?"No wage set · estimate":fmt(p.wageCents,data.currency)+"/h"}</div></div>
      <div className="text-end">{hours(data.shifts.filter(s=>s.employeeId===p.id).reduce((n,s)=>n+s.paidMinutes,0))} h</div>
      <button disabled={data.readOnly} onClick={()=>openPerson(p)} className="min-h-12 px-2">Edit</button>
     </div>)}
     <div className="border-t border-line pt-3 font-bold">Total {fmt(data.total.knownCostCents,data.currency)} {data.total.estimated?"· estimate":""}</div>
   </section>
   <Link href={`/${locale}/staff/rules`} className="block rounded-[20px] border border-line bg-surface p-4">Breaks, overtime, rest, coverage → <span className="block text-muted">Using defaults · change anytime</span></Link>
  </>}
  {undo&&<div role="status" className="fixed inset-x-4 bottom-36 z-30 flex items-center justify-between rounded-xl bg-fg p-4 text-bg shadow-lg"><span>{undo.message}</span><button onClick={undoRemove} className="min-h-12 px-3 font-bold">Undo</button></div>}
  {error&&<p role="alert" className="rounded-xl bg-neg-soft p-3 text-neg">{error}</p>}
  {notice&&<div role="dialog" className="fixed inset-4 z-50 overflow-auto rounded-2xl bg-surface p-5 shadow-2xl"><h2>Ready to copy</h2><pre className="whitespace-pre-wrap">{notice}</pre><button onClick={()=>navigator.clipboard.writeText(notice)} className="my-3 min-h-12 rounded-xl bg-accent px-4 text-on-accent">Copy</button><button onClick={()=>setNotice("")} className="ms-3 min-h-12">Close</button></div>}
  {sheet&&<div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50" onClick={()=>setSheet(null)}>
   <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl bg-surface p-5 pb-8" onClick={e=>e.stopPropagation()} role="dialog" aria-modal="true">
    <div className="mx-auto mb-3 h-1 w-12 rounded bg-line"/><h2 className="font-headline text-xl font-bold">{sheet==="person"?(personEditing?"Edit person":"Add person"):"Add / edit shift"}</h2>
    {sheet==="person"?<>
      <label className="mt-3 block font-semibold">Name<input value={name} onChange={e=>setName(e.target.value)} className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3"/></label>
      <div className="mt-3 flex flex-wrap gap-2">{["Barista","Manager","Baker","Cashier"].map(r=><button key={r} aria-pressed={role===r} onClick={()=>setRole(r)} className="min-h-12 rounded-full border border-line px-3">{r}</button>)}</div>
      <p className="mt-4 text-muted">Optional · skip any</p>
      <label className="mt-3 block">Hourly wage (optional)<div className="mt-2 flex items-center gap-4">
       <button className="min-h-12 min-w-12 rounded-xl bg-surface2" onClick={()=>setWage(Math.max(0,(wage??1900)-50))}>−</button>
       <strong>{wage==null?"Estimate":fmt(wage,data.currency)}</strong>
       <button className="min-h-12 min-w-12 rounded-xl bg-surface2" onClick={()=>setWage((wage??1850)+50)}>+</button>
       <button onClick={()=>setWage(null)} className="min-h-12">Skip</button></div></label>
      <div className="mt-4"><h3 className="font-bold">Usually available</h3>
       <p className="text-sm text-muted">Choose days. Leave times blank for any time.</p>
       {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((label,day)=>{
        const row=availability.find(d=>d.day===day);
        return <div key={day} className="border-b border-line py-2">
         <div className="flex min-h-12 items-center gap-2">
          <button type="button" aria-pressed={Boolean(row)} onClick={()=>mutateAvailability(day,row?null:{start:null,end:null})}
           className={`min-h-12 min-w-14 rounded-xl px-3 ${row?"bg-accent text-on-accent":"bg-surface2 text-muted"}`}>{label}</button>
          <span className="flex-1 text-sm">{row?(row.start&&row.end?row.start+" – "+row.end:"Any time"):"Off"}</span>
          {row&&<button type="button" className="min-h-12 rounded-lg border border-line px-3" onClick={()=>mutateAvailability(day,row.start?{start:null,end:null}:{start:"06:00",end:"12:00"})}>
           {row.start?"Any time":"Set hours"}</button>}
         </div>
         {row?.start&&row.end&&<div className="grid grid-cols-2 gap-2 pt-2">{(["start","end"] as const).map(field=>
          <div key={field} className="rounded-xl bg-surface2 p-2"><div className="text-sm">{field==="start"?"From":"Until"}</div>
           <div className="flex items-center justify-between gap-1">
            <button type="button" onClick={()=>mutateAvailability(day,{...row,[field]:timeStep(row[field]!, -30)})} className="min-h-12 min-w-10">−</button>
            <strong>{row[field]}</strong>
            <button type="button" onClick={()=>mutateAvailability(day,{...row,[field]:timeStep(row[field]!,30)})} className="min-h-12 min-w-10">+</button>
           </div></div>)}</div>}
        </div>;
       })}
      </div>
      {([["Minimum hours a week",minWeeklyMinutes,setMinWeeklyMinutes],
         ["Maximum hours a week",maxWeeklyMinutes,setMaxWeeklyMinutes]] as const).map(([label,value,set])=>
       <div key={label} className="mt-3"><label className="font-semibold">{label} (optional)</label>
         <div className="mt-1 flex items-center justify-between rounded-xl bg-surface2">
          <button type="button" className="min-h-12 min-w-12" onClick={()=>set(value===null?null:Math.max(0,value-60))}>−</button>
          <span>{value===null?"Not set":hours(value)+" h"}</span>
          <button type="button" className="min-h-12 min-w-12" onClick={()=>set((value??0)+60)}>+</button>
          <button type="button" className="min-h-12 px-2" onClick={()=>set(null)}>Clear</button>
         </div></div>)}
      <label className="mt-3 block font-semibold">WhatsApp number (optional)
        <input type="tel" value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+14155551234"
         className="mt-1 min-h-12 w-full rounded-xl border border-line bg-surface px-3" dir="ltr"/>
      </label>
      <button disabled={busy||!name.trim()} onClick={()=>run(()=>{
       const fields={name,role:role||null,wageCents:wage,availability,
        minWeeklyMinutes,maxWeeklyMinutes,phone:phone.trim()||null};
       return personEditing?updatePerson({id:personEditing,...fields}):addPerson(fields);
      })} className="mt-5 min-h-14 w-full rounded-xl bg-accent text-on-accent">
       {personEditing?"Save changes":"Add "+name.trim()}</button>
      {personEditing&&<button disabled={busy} onClick={removePerson} className="mt-2 min-h-12 w-full text-neg">Remove person · Undo available</button>}
    </>:<>
      <label className="mt-3 block">Who<select value={chosen} onChange={e=>setChosen(e.target.value)} className="min-h-12 w-full rounded-xl border border-line bg-surface">{data.team.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {([["Start",start,setStart],["End",end,setEnd]] as const).map(([label,time,set])=><div key={label} className="mt-3">
       <b>{label}</b><div className="flex items-center justify-between rounded-xl bg-surface2">
        <button onClick={()=>set(new Date(Date.parse("2000-01-01T"+time+":00Z")-1800000).toISOString().slice(11,16))} className="min-h-12 min-w-12">−</button>
        <span>{time}</span>
        <button onClick={()=>set(new Date(Date.parse("2000-01-01T"+time+":00Z")+1800000).toISOString().slice(11,16))} className="min-h-12 min-w-12">+</button>
       </div></div>)}
      <label className="mt-3 flex min-h-12 items-center gap-2">Unpaid break
       <button onClick={()=>setBreakMin(Math.max(0,breakMin-10))} className="min-h-12 min-w-12">−</button>{breakMin} min<button onClick={()=>setBreakMin(Math.min(240,breakMin+10))} className="min-h-12 min-w-12">+</button></label>
      <button disabled={busy||!chosen} onClick={()=>run(()=>upsertShift({id:editing??undefined,employeeId:chosen,date,start,end,breakMinutes:breakMin}))}
       className="mt-5 min-h-14 w-full rounded-xl bg-accent text-on-accent">Save shift</button>
      {editing&&<button className="mt-3 min-h-12 w-full text-neg" onClick={removeCurrentShift}>Remove shift</button>}
    </>}
    <button onClick={()=>setSheet(null)} className="mt-3 min-h-12 w-full">Cancel</button>
   </div></div>}
 </div>;
}
