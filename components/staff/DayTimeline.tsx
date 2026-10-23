"use client";
import {dayTimeline,type DetailedShift,type ScheduleGap} from "@/lib/calc/scheduling/schedulePresentation";
import type {OpenHours} from "@/lib/business/openHours";
const palettes=["bg-accent-soft text-accent-text border-accent-text/20",
 "bg-pos-soft text-pos border-pos/20","bg-warn-soft text-warn-text border-warn-text/20",
 "bg-surface2 text-fg border-line","bg-accent-soft text-accent-text border-accent-text/20"] as const;
export default function DayTimeline({date,shifts,gaps,openHours,people,onShiftClick,preview}:{
 date:string;shifts:DetailedShift[];gaps:ScheduleGap[];openHours:OpenHours|null;
 people:{id:string;colorIndex:number|null}[];onShiftClick?:(id:string)=>void;preview?:DetailedShift|null
}){
 const rendered=dayTimeline(date,preview?[...shifts.filter(s=>s.id!==preview.id),preview]:shifts,gaps,openHours);
 return <div className="w-full" dir="ltr">
  <div className="relative mt-2" style={{height:rendered.height}}>
   {rendered.open.map((band,i)=><div key={"open"+i} aria-hidden="true"
     className="absolute inset-y-0 border-x border-dashed border-accent-text/30 bg-accent-soft/50"
     style={{left:band.left+"%",width:band.width+"%"}}/>)}
   {rendered.gaps.map((band,i)=><div key={"gap"+i} aria-hidden="true" className="absolute inset-y-0"
    style={{left:band.left+"%",width:band.width+"%",
      backgroundImage:"repeating-linear-gradient(135deg,rgb(var(--c-neg) / 0.17) 0 5px,rgb(var(--c-neg) / 0.04) 5px 10px)"}}/>)}
   {rendered.blocks.map(block=>{
    const person=people.find(p=>p.id===block.employeeId);
    const style=palettes[Math.abs(person?.colorIndex??people.findIndex(p=>p.id===block.employeeId))%palettes.length];
    return <button type="button" key={block.id} title={block.title} aria-label={block.title}
     onClick={()=>onShiftClick?.(block.id)} disabled={!onShiftClick}
     className={`absolute flex h-[26px] min-w-[18px] items-center truncate rounded-lg border px-1.5 text-[12px] font-bold ${style} ${preview?.id===block.id?"outline outline-[3px] outline-offset-1 outline-accent-text":""}`}
     style={{top:block.top,left:block.left+"%",width:Math.max(block.width,4)+"%"}}>
     <span className="truncate">{block.title}</span></button>;
   })}
  </div>
  <div className="relative mt-2 h-4 text-[11px] font-semibold text-muted">{rendered.ticks.map(t=>
    <span key={t.at} className="absolute -translate-x-1/2" style={{left:t.at+"%"}}>{t.label}</span>)}</div>
 </div>;
}
