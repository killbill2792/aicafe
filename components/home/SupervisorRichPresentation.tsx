"use client";
import {createContext,useContext,useMemo,useState} from "react";
import dynamic from "next/dynamic";
import {JSONUIProvider,Renderer,type ComponentRegistry} from "@json-render/react";
import {Paperclip} from "lucide-react";
import type {StoredAttachment} from "@/lib/ai/conversations/attachments";
import type {Spec} from "@json-render/core";
import type {ComparisonSeries} from "./SupervisorRichChart";
import {evaluateScenarioEditor,scenarioEditFields} from "@/lib/ai/conversations/scenarioPresentation";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {richPresentationSchema,presentationPanelSchema,agendaSchema,scenarioComparisonSchema,presentationReport,recordTableSchema,interactiveCalcSchema,evaluatePresentationCalc,presentationLeaves,presentationGroupRoots,allPresentationLeaves,compatibleComparison,descriptiveGroupTitle,calendarPage,type RecordTable,type InteractiveCalc,type Agenda,type ScenarioComparison,type RichPresentation,type PresentationPanel} from "@/lib/ai/conversations/presentation";
const copy=en.SupervisorPresentation;
const Chart=dynamic(()=>import("./SupervisorRichChart"),{ssr:false});
const ComparisonChart=dynamic(()=>import("./SupervisorRichChart").then(m=>m.ComparisonChart),{ssr:false});
export function presentationSpec(p:RichPresentation):Spec{
 const elements:Spec["elements"]={root:{type:"Layout",props:{layout:p.layout},children:presentationLeaves(p)}};
 p.panels.forEach((panel,i)=>{elements["panel"+i]={type:"Panel",props:{panel},children:[]}});
 if(p.agenda)elements.agenda={type:"Agenda",props:{agenda:p.agenda},children:[]};
 if(p.scenario)elements.scenario={type:"Scenario",props:{scenario:p.scenario},children:[]};
 p.tables?.forEach((table,i)=>{elements["table"+i]={type:"RecordTable",props:{table},children:[]}});
 if(p.calculator)elements.calculator={type:"Calculator",props:{calculator:p.calculator},children:[]};
 if(p.groups?.some(g=>g.id)){
  for(const key of allPresentationLeaves(p).filter(k=>["files","report","suggestions"].includes(k)))elements[key]={type:"Control",props:{kind:key},children:[]};
 }
 if(p.groups){
  elements.root.props={layout:"stack"};
  const ids=new Map(p.groups.flatMap((g,i)=>g.id?[[g.id,"group"+i] as const]:[]));
  elements.root.children=presentationGroupRoots(p.groups).map(i=>"group"+i);
  p.groups.forEach((g,i)=>{
   const title=descriptiveGroupTitle(g.title);
   elements["group"+i]=g.layout==="compare"&&compatibleComparison(g.items,p.panels)?{type:"Comparison",props:{panels:g.items.map(k=>p.panels[Number(k.slice(5))]),...(title?{title}:{})},children:[]}:{type:"Layout",props:{layout:g.layout==="details"&&!title?"stack":g.layout,...(title?{title}:{})},children:g.items.map(key=>ids.get(key)??key)};
  });
 }
 return {root:"root",elements};
}
function Panel({panel,locale}:{panel:PresentationPanel;locale:string}){
 const formatter=new Intl.NumberFormat(locale,["cents","cents/hour"].includes(panel.unit)&&panel.currency?
  {style:"currency",currency:panel.currency,minimumFractionDigits:2,maximumFractionDigits:2}:{maximumFractionDigits:20});
 const format=(v:number)=>formatter.format(["cents","cents/hour"].includes(panel.unit)?v/100:v)+(panel.unit==="cents/hour"?" / h":["seconds","minutes","hours","days","units","items","ratio","ratio squared","indicator"].includes(panel.unit)?" "+(panel.measurement??panel.unit):"");
 const table=<div className="overflow-x-auto overscroll-x-contain"><table className="w-full text-[17px] tabular-nums"><caption className="sr-only">{panel.title}</caption>
    <tbody>{panel.points.map((p,i)=><tr key={i} className="border-b border-line"><th scope="row" className="break-words py-2 pe-3 text-start font-normal">{p.label}</th><td className="py-2 text-end">{format(p.value)}</td></tr>)}</tbody>
   </table></div>;
 return <figure className="min-w-0 space-y-2 py-2">
  <figcaption className="text-[17px] font-medium leading-snug text-ink">{panel.title}</figcaption>
  {panel.coverage&&<p className="text-[13px] text-ink-muted">{panel.coverage==="partial"?copy.partial:copy.estimate}</p>}
  {panel.kind==="metric"?<p className="break-words font-headline text-[30px] font-medium leading-tight tracking-tight tabular-nums text-ink">{format(panel.points[0].value)}</p>:
   (panel.kind==="table"||panel.kind==="ranked_table")?table:<><Chart panel={panel} format={format}/>
    <details className="text-ink"><summary className="flex min-h-12 cursor-pointer items-center text-[15px] text-accent-text underline underline-offset-4">{({en,es,ar}[locale as "en"|"es"|"ar"]??en).Home.chatStartDetails}</summary>{table}</details></>}
  <p className="break-words text-[13px] leading-relaxed text-ink-muted">{panel.from} – {panel.to} · {panel.sourceDetail??(panel.source==="daily_rollups"?"Sales records":panel.source==="item_sales"?"Item sales":panel.source==="canonical_data"?panel.sourceDetail??"Canonical records":panel.source==="expenses"?"Recorded expenses":panel.source==="business_costs"?"Business costs":panel.source==="product_costs"?"Product economics":panel.source==="supplier_purchase_plan"?"Supplier quotes":panel.source==="purchase_orders"?"Purchase orders":panel.source==="inventory"?"Inventory":panel.source==="menu_items"?"Menu":"Profitability")} · {copy.snapshot} {panel.asOf}</p>
 </figure>;
}
function ComparisonView({panels,locale}:{panels:PresentationPanel[];locale:string}){
 const first=panels[0],scalar=panels.every(p=>p.points.length===1);
 const series:ComparisonSeries[]=panels.map((p,i)=>({id:"s"+i,label:(i+1)+". "+p.title+" · "+p.from+" – "+p.to,points:p.points.map(v=>({label:scalar?"—":v.label,value:v.value}))}));
 const labels=[...new Set(series.flatMap(s=>s.points.map(v=>v.label)))];
 const line=panels.every(p=>p.kind==="line");
 if(line)labels.sort();
 const fmt=new Intl.NumberFormat(locale,["cents","cents/hour"].includes(first.unit)&&first.currency?{style:"currency",currency:first.currency,minimumFractionDigits:2,maximumFractionDigits:2}:{maximumFractionDigits:20});
 const format=(v:number)=>fmt.format(["cents","cents/hour"].includes(first.unit)?v/100:v);
 return <figure data-testid="supervisor-comparison" className="min-w-0 space-y-2 py-2">
  <ComparisonChart series={series} labels={labels} line={line} format={format}/>
  <div className="flex flex-wrap gap-3 text-[13px] text-ink-muted">{series.map(s=><span key={s.id}>{s.label}</span>)}</div>
  <div className="overflow-x-auto" tabIndex={0} aria-label={series.map(s=>s.label).join("; ")}>
   <table className="w-full text-[15px] tabular-nums"><thead><tr><th scope="col" className="py-2 text-start">{first.currency??first.measurement??first.unit}</th>{series.map(s=><th key={s.id} scope="col" className="px-2 text-end">{s.label}</th>)}</tr></thead>
    <tbody>{labels.map(label=><tr key={label}><th scope="row" className="py-2 text-start">{label}</th>{series.map(s=>{const v=s.points.find(p=>p.label===label);return <td key={s.id} className="px-2 text-end">{v?format(v.value):copy.notRecorded}</td>})}</tr>)}</tbody></table>
  </div>
  {panels.map((p,i)=><p key={i} className="break-words text-[13px] text-ink-muted">{series[i].label} · {p.sourceDetail??p.source} · {copy.snapshot} {p.asOf}{p.coverage?" · "+(p.coverage==="partial"?copy.partial:copy.estimate):""}</p>)}
 </figure>;
}
function AgendaView({agenda,locale}:{agenda:Agenda;locale:string}){
 // These are café-local civil dates, not timestamps. Format their calendar
 // fields at local noon; no hardcoded café timezone or conversion.
 const format=(day:string)=>{const [y,m,d]=day.split("-").map(Number);return new Intl.DateTimeFormat(locale,{dateStyle:"medium"}).format(new Date(y,m-1,d,12));}; // hardcode-ok: date-only café calendar labels, not timestamps; preserve the already-resolved calendar day in every viewer timezone.
 const status:Record<Agenda["entries"][number]["status"],string>=copy.eventStatuses;
 const [page,setPage]=useState(0);
 const [selected,setSelected]=useState<string|null>(null);
 const window=calendarPage(agenda,page);
 const current=window.days.find(d=>d.date===selected)??window.days.find(d=>d.entries.length)??window.days[0];
 return <section data-testid="supervisor-agenda" className="min-w-0 space-y-3 py-2">
  <h3 className="font-medium text-ink">{agenda.title}</h3>
  <p className="text-[13px] text-ink-muted">{format(agenda.from)} – {format(agenda.to)} · {copy.snapshot} {format(agenda.asOf)}{agenda.coverage==="partial"?" · "+copy.partial:""}</p>
  {agenda.kind==="calendar"?<>
    <div className="flex items-center justify-between gap-2 text-[15px]">
     <button type="button" aria-label={copy.previousDates} disabled={window.page===0} onClick={()=>{setPage(window.page-1);setSelected(null)}} className="min-h-12 min-w-12 rounded-lg border border-line disabled:opacity-40">‹</button>
     <span className="text-center">{format(window.days[0].date)} – {format(window.days[window.days.length-1].date)}</span>
     <button type="button" aria-label={copy.nextDates} disabled={window.page+1===window.pages} onClick={()=>{setPage(window.page+1);setSelected(null)}} className="min-h-12 min-w-12 rounded-lg border border-line disabled:opacity-40">›</button>
    </div>
    <div data-testid="supervisor-calendar-grid" className="grid grid-cols-7 gap-1" aria-label={agenda.title}>
     {Array.from({length:7},(_,i)=><span key={i} className="text-center text-[13px] text-ink-muted">{new Intl.DateTimeFormat(locale,{weekday:"short"}).format(new Date(2024,0,7+i,12))}</span>)}
     {Array.from({length:window.days[0].weekday},(_,i)=><span key={"empty"+i} aria-hidden="true"/>)}
     {window.days.map(d=><button type="button" key={d.date} aria-label={format(d.date)+" · "+d.entries.length+" "+copy.savedEntries} aria-pressed={current.date===d.date} onClick={()=>setSelected(d.date)} className={"min-h-12 min-w-0 rounded-lg border px-0.5 py-1 text-center tabular-nums focus-visible:outline focus-visible:outline-2 "+(current.date===d.date?"border-accent bg-surface2":"border-line")}>
      <span className="block text-[15px]">{Number(d.date.slice(-2))}</span><span className="block text-[13px] text-ink-muted">{d.entries.length?d.entries.length:"·"}</span>
     </button>)}
    </div>
    <h4 className="font-medium"><time dateTime={current.date}>{format(current.date)}</time></h4>
    {current.entries.length===0&&<p className="text-[15px] text-ink-muted">{copy.noSavedEntries}</p>}
    <ul className="space-y-2">{current.entries.map((e,i)=><li key={i} className="break-words border-s border-line ps-3">
      <p>{e.label}</p><p className="text-[13px] text-ink-muted">{e.start??copy.timeUnknown}{e.end?" – "+e.end:""}{e.endDate!==e.date?" · "+format(e.date)+" – "+format(e.endDate):""} · {status[e.status]}{e.checkedAt?" · "+copy.snapshot+" "+e.checkedAt:""}</p>
    </li>)}</ul>
  </>:<ol className="space-y-3 border-s border-line ps-4">{agenda.entries.map((e,i)=><li key={i} className="break-words">
   <time dateTime={e.date} className="text-[13px] text-ink-muted">{format(e.date)}{e.endDate!==e.date?" – "+format(e.endDate):""}</time>
   <p className="font-medium">{e.label}</p><p className="text-[13px] text-ink-muted">{e.start??copy.timeUnknown}{e.end?" – "+e.end:""} · {status[e.status]}{e.checkedAt?" · "+copy.snapshot+" "+e.checkedAt:""}</p>
  </li>)}</ol>}
  <p className="text-[13px] text-ink-muted">{agenda.source==="cafe_events"?copy.eventNotice:copy.shiftNotice}</p>
 </section>;
}
function RecordTableView({table,locale}:{table:RecordTable;locale:string}){
 const fmt=(value:RecordTable["rows"][number][number],u:RecordTable["columns"][number]["unit"])=>{
  if(value===null)return copy.notRecorded;
  if(typeof value!=="number")return String(value);
  if((u==="cents"||u==="cents/hour")&&table.currency)
   return new Intl.NumberFormat(locale,{style:"currency",currency:table.currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(value/100)+(u==="cents/hour"?" / h":"");
  return new Intl.NumberFormat(locale,{maximumFractionDigits:20}).format(value);
 };
 return <figure data-testid="supervisor-record-table" className="min-w-0 space-y-2 py-2">
  <figcaption className="font-medium text-ink">{table.title}</figcaption>
  <p className="break-words text-[13px] text-ink-muted">{table.view} · {table.from} – {table.to} · {copy.snapshot} {table.asOf}{table.coverage==="partial"?" · "+copy.partial:""}</p>
  <p className="break-words text-[13px] text-ink-muted">{table.scope}</p>
  <div tabIndex={0} aria-label={table.title} className="max-w-full overflow-x-auto overscroll-x-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
   <table className="w-full text-[15px] tabular-nums"><caption className="sr-only">{table.title}</caption>
    <thead><tr>{table.columns.map((c,i)=><th key={i} scope="col" className="border-b border-line px-2 py-2 text-start align-bottom font-medium">{c.label}<span className="block text-[13px] text-ink-muted">{c.unit==="stored"?copy.unitUnknown:c.unit==="microcents"?table.currency+" microcents":c.unit==="cents"?table.currency:c.unit==="cents/hour"?table.currency+" / h":c.unit}</span></th>)}</tr></thead>
    <tbody>{table.rows.map((row,i)=><tr key={i}>{row.map((v,j)=><td key={j} className="border-b border-line px-2 py-2 text-start align-top break-words">{fmt(v,table.columns[j].unit)}</td>)}</tr>)}</tbody>
   </table>
  </div>
 </figure>;
}
function CalculatorView({calculator,locale}:{calculator:InteractiveCalc;locale:string}){
 const [changes,setChanges]=useState<Record<string,string>>({});
 const outcome=evaluatePresentationCalc(calculator,changes);
 const number=(v:InteractiveCalc["original"])=>v.unit==="cents"?v.valueCents/100:v.unit==="percent"?v.valueBps/100:v.unit==="count"?v.quantity:v.valueRatio;
 const fmt=(v:InteractiveCalc["original"])=>v.unit==="cents"&&calculator.currency?
  new Intl.NumberFormat(locale,{style:"currency",currency:calculator.currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(number(v)):
  new Intl.NumberFormat(locale,{maximumFractionDigits:4}).format(number(v))+(v.unit==="percent"?"%":"");
 return <section data-testid="supervisor-calculator" className="min-w-0 space-y-3 py-2">
  <h3 className="font-medium text-ink">{calculator.title}</h3>
  <p className="text-[13px] text-ink-muted">{copy.calculatorNotice} · {copy.snapshot} {calculator.asOf}</p>
  {calculator.inputs.map(i=>i.editable?<label key={i.id} className="block text-[15px]">
   {i.label}{i.value.unit==="cents"?" ("+calculator.currency+")":i.value.unit==="percent"?" (%)":""}
   <input type="text" inputMode="decimal" maxLength={13} value={changes[i.id]??String(number(i.value))} onChange={e=>setChanges(prev=>({...prev,[i.id]:e.target.value}))} className="mt-1 block min-h-12 w-full rounded-xl border border-line bg-surface px-3 tabular-nums"/>
  </label>:<p key={i.id} className="break-words text-[15px]">{i.label}: {fmt(i.value)}</p>)}
  <p role="status" className="break-words text-xl font-medium tabular-nums">{outcome?fmt(outcome):copy.invalidCalculation}</p>
  <button type="button" className="min-h-12 text-[15px] underline" onClick={()=>setChanges({})}>{copy.resetAssumptions}</button>
 </section>;
}
function ScenarioView({scenario,locale}:{scenario:ScenarioComparison;locale:string}){
 const [index,setIndex]=useState(0);
 const selected=scenario.cases[index]??scenario.cases[0];
 const [changes,setChanges]=useState<Record<string,string>>({});
 const edited=selected.editor?evaluateScenarioEditor(selected.editor,changes):null;
 const fmt=(v:number)=>new Intl.NumberFormat(locale,{style:"currency",currency:scenario.currency,minimumFractionDigits:2,maximumFractionDigits:2}).format(v/100);
 return <section data-testid="supervisor-scenario" className="min-w-0 space-y-3 py-2">
  <h3 className="font-medium text-ink">{scenario.title}</h3>
  <p className="text-[13px] text-ink-muted">{copy.estimate} · {copy.snapshot} {scenario.asOf}. {copy.noChange}</p>
  {scenario.cases.length>1?<label className="block text-[15px]">{copy.compareAssumptions}
   <select value={index} onChange={e=>{setIndex(Number(e.target.value));setChanges({});}} className="mt-1 block min-h-12 w-full rounded-xl border border-line bg-surface px-3">
    {scenario.cases.map((c,i)=><option value={i} key={i}>{c.assumption}</option>)}
   </select></label>:<p>{selected.assumption}</p>}
  {selected.editor&&<div data-testid="supervisor-scenario-editor" className="space-y-2">
    <p className="text-[13px] text-ink-muted">{copy.calculatorNotice}</p>
    {scenarioEditFields(selected.editor).map(f=><label key={f.key} className="block text-[15px]">{copy.scenarioEditFields[f.key as keyof typeof copy.scenarioEditFields]??f.label}{f.money?" ("+scenario.currency+")":f.percent?" (%)":""}
      <input type="text" inputMode="decimal" maxLength={15} value={changes[f.key]??String(f.value)} onChange={e=>setChanges(prev=>({...prev,[f.key]:e.target.value}))} className="mt-1 block w-full min-h-12 rounded-xl border border-line bg-surface px-3 tabular-nums"/>
    </label>)}
    <button type="button" className="min-h-12 underline text-[15px]" onClick={()=>setChanges({})}>{copy.resetAssumptions}</button>
  </div>}
  <dl className="grid grid-cols-2 gap-2 tabular-nums">
   <div><dt className="text-[13px] text-ink-muted">{copy.baselineEstimate}</dt><dd className="break-words text-xl font-medium">{fmt(selected.beforeCents)}</dd></div>
   <div><dt className="text-[13px] text-ink-muted">{copy.scenarioEstimate}</dt><dd className="break-words text-xl font-medium"><span role="status">{selected.editor?edited?fmt(edited.afterCents):copy.invalidCalculation:fmt(selected.afterCents)}</span></dd></div>
  </dl>
  {!selected.editor&&<p className="text-[13px] text-ink-muted">{copy.scenarioNotice}</p>}
 </section>;
}
type ControlContext={data:RichPresentation;message?:Parameters<typeof presentationReport>[1]&{threadId:string};attachments?:{threadId:string;items:StoredAttachment[]}|null;onSuggest:(text:string)=>void;disabled:boolean};
const PresentationControls=createContext<ControlContext|null>(null);
function ControlView({kind}:{kind:unknown}){
 const context=useContext(PresentationControls);
 if(!context)return null;
 const {data,message,attachments,onSuggest,disabled}=context;
 const download=()=>{
  if(!message||!data.report)return;
  const url=URL.createObjectURL(new Blob([presentationReport(data,message)],{type:"text/plain;charset=utf-8"}));
  const anchor=document.createElement("a");anchor.href=url;anchor.download="supervisor-report.txt";anchor.click();
  // The browser owns the local download; release the in-memory snapshot afterwards.
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
 return <>
  {kind==="files"&&!!data.files?.length&&message&&<section aria-label={copy.sourceAttachments} className="space-y-2">
    <h3 className="text-[15px] font-medium text-ink-muted">{copy.sourceAttachments}</h3>
    {data.files.map((id,i)=>{const file=attachments?.threadId===message.threadId?attachments.items.find(f=>f.id===id):null;
     return <a key={id} href={"/api/ai/threads/"+encodeURIComponent(message.threadId)+"/attachments/"+encodeURIComponent(id)} target="_blank" rel="noopener noreferrer" className="flex min-h-12 min-w-0 items-center gap-2 rounded-lg border border-line px-3 text-[15px] text-ink underline"><Paperclip size={17} className="shrink-0" aria-hidden="true"/><span className="min-w-0 break-all">{file?.originalName??copy.sourceFile+" "+(i+1)}</span></a>;
    })}
  </section>}
  {kind==="report"&&data.report&&message&&<button type="button" onClick={download} className="min-h-12 rounded-xl border border-line px-4 text-start text-[15px] font-medium text-ink hover:bg-surface2">{copy.downloadReport}</button>}
  {kind==="suggestions"&&data.suggestions.length>0&&<div className="flex flex-wrap gap-2">{data.suggestions.map(prompt=><button key={prompt} type="button" disabled={disabled} onClick={()=>onSuggest(prompt)} className="min-h-12 max-w-full rounded-full border border-line px-4 py-2 text-start text-[15px] leading-snug text-ink hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">{prompt}</button>)}</div>}
 </>;
}
export default function SupervisorRichPresentation({block,locale,onSuggest,disabled,message,attachments}:{block:unknown;locale:string;onSuggest:(text:string)=>void;disabled:boolean;message?:Parameters<typeof presentationReport>[1]&{threadId:string};attachments?:{threadId:string;items:StoredAttachment[]}|null}){
 const parsed=useMemo(()=>richPresentationSchema.safeParse(block),[block]);
 const registry=useMemo<ComponentRegistry>(()=>({
  Layout:({element,children})=>{
   const title=typeof element.props.title==="string"?element.props.title:null;
   if(element.props.layout==="details"&&title)return <details data-supervisor-layout="details" className="min-w-0 space-y-2"><summary className="min-h-12 cursor-pointer break-words py-3 text-[17px] font-medium text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">{title}</summary>{children}</details>;
   return <div data-supervisor-layout={element.props.layout==="grid"?"grid":"stack"} className="min-w-0 space-y-2">
    {title&&<h3 className="break-words text-[17px] font-medium text-ink">{title}</h3>}
    <div className={element.props.layout==="grid"?"grid min-w-0 gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))]":"min-w-0 space-y-3"}>{children}</div>
   </div>;
  },
  Panel:({element})=>{const p=presentationPanelSchema.safeParse(element.props.panel);return p.success?<Panel panel={p.data} locale={locale}/>:null;},
  Comparison:({element})=>{const raw:unknown=element.props.panels;const p=Array.isArray(raw)?raw.map((v:unknown)=>presentationPanelSchema.safeParse(v)):[];if(p.some(v=>!v.success))return null;const panels=p.flatMap(v=>v.success?[v.data]:[]);return compatibleComparison(panels.map((_,i)=>"panel"+i),panels)?<div className="min-w-0">{typeof element.props.title==="string"&&<h3 className="break-words text-[17px] font-medium text-ink">{element.props.title}</h3>}<ComparisonView panels={panels} locale={locale}/></div>:null;},
  Agenda:({element})=>{const a=agendaSchema.safeParse(element.props.agenda);return a.success?<AgendaView agenda={a.data} locale={locale}/>:null;},
  Scenario:({element})=>{const s=scenarioComparisonSchema.safeParse(element.props.scenario);return s.success?<ScenarioView scenario={s.data} locale={locale}/>:null;},
  RecordTable:({element})=>{const t=recordTableSchema.safeParse(element.props.table);return t.success?<RecordTableView table={t.data} locale={locale}/>:null;},
  Control:({element})=><ControlView kind={element.props.kind}/>,
  Calculator:({element})=>{const c=interactiveCalcSchema.safeParse(element.props.calculator);return c.success?<CalculatorView calculator={c.data} locale={locale}/>:null;},
 }),[locale]);
 if(!parsed.success)return null;
 const data=parsed.data,composed=Boolean(data.groups?.some(g=>g.id));
 return <PresentationControls.Provider value={{data,message,attachments,onSuggest,disabled}}><section className="min-w-0 space-y-3" data-testid="supervisor-rich-presentation">
  {(presentationLeaves(data).length>0||composed)&&<JSONUIProvider registry={registry}><Renderer spec={presentationSpec(data)} registry={registry}/></JSONUIProvider>}
  {!composed&&<><ControlView kind="files"/><ControlView kind="report"/><ControlView kind="suggestions"/></>}
 </section></PresentationControls.Provider>;
}
