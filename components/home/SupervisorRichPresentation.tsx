"use client";
import {createContext,useContext,useId,useMemo,useState,useLayoutEffect,useRef,type CSSProperties,type ReactNode} from "react";
import dynamic from "next/dynamic";
import PresentationBoundary from "./PresentationBoundary";
import {normalizeTableData} from "@/lib/ai/conversations/tableFormatting";
import {wideResponseTableClass,wideResponseCellClass,wideResponseLabelClass} from "./responseTableLayout";
import {JSONUIProvider,Renderer,defineRegistry,type ComponentRegistry} from "@json-render/react";
import {defineCatalog} from "@json-render/core";
import {schema} from "@json-render/react/schema";
import {shadcnComponents} from "@json-render/shadcn";
import {upstreamComponents,nativeChartDefinition,nativeChartProps,nativeFunctions,createLocalWidgetStore,parseUpstreamProps,readNativeSnapshot} from "@/lib/ai/conversations/nativePresentation";
import {z} from "zod";
import {Paperclip} from "lucide-react";
import type {StoredAttachment} from "@/lib/ai/conversations/attachments";
import type {Spec} from "@json-render/core";
import type {ComparisonSeries} from "./SupervisorRichChart";
import {evaluateScenarioEditor,scenarioEditFields} from "@/lib/ai/conversations/scenarioPresentation";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import {recoverRichPresentation,presentationPanelSchema,agendaSchema,scenarioComparisonSchema,presentationReport,recordTableSchema,interactiveCalcSchema,evaluatePresentationCalc,presentationLeaves,presentationGroupRoots,allPresentationLeaves,compatibleComparison,descriptiveGroupTitle,calendarPage,type RecordTable,type InteractiveCalc,type Agenda,type ScenarioComparison,type RichPresentation,type PresentationPanel} from "@/lib/ai/conversations/presentation";
const copy=en.SupervisorPresentation;
const confidence=(coverage:string)=>coverage==="partial"?copy.partial:coverage==="estimate"?copy.estimate:coverage==="unverified"?"Unverified":coverage;
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
type DisplayPanel=Omit<PresentationPanel,"from"|"to"|"asOf">&Partial<Pick<PresentationPanel,"from"|"to"|"asOf">>;
function Panel({panel,locale}:{panel:DisplayPanel;locale:string}){
 const evidenceId=useId(),coverageId=useId();
 const money=["cents","cents/hour"].includes(panel.unit);
 const currency=money&&panel.currency&&/^[A-Za-z]{3}$/.test(panel.currency)?panel.currency:null;
 const formatter=new Intl.NumberFormat(locale,currency?
  {style:"currency",currency,minimumFractionDigits:2,maximumFractionDigits:20}:{maximumFractionDigits:20});
 const format=(v:number)=>formatter.format(money?v/100:v)+(money&&!currency?" "+(panel.currency??"(currency not set)"):"")+(panel.unit==="cents/hour"?" / h":["seconds","minutes","hours","days","units","items","ratio","ratio squared","indicator"].includes(panel.unit)?" "+(panel.measurement??panel.unit):"");
 const detailsLabel=({en,es,ar}[locale as "en"|"es"|"ar"]??en).Home.chatStartDetails;
 const table=<div role="region" aria-label={panel.title} tabIndex={0} className="overflow-x-auto overscroll-x-contain focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ink"><table aria-describedby={panel.coverage&&panel.source!=="response_evidence"?coverageId+" "+evidenceId:evidenceId} className="w-full text-[1.0625rem] tabular-nums"><caption className="sr-only">{panel.title}</caption>
    <thead><tr><th scope="col" className="py-2 text-start">{copy.categoryLabel}</th><th scope="col" className="py-2 text-end">{copy.valueLabel}{panel.currency?" ("+panel.currency+")":panel.measurement?" ("+panel.measurement+")":""}</th></tr></thead>
    <tbody>{panel.points.map((p,i)=><tr key={i} className="border-b border-line"><th scope="row" className="wrap-break-word py-2 pe-3 text-start font-normal">{p.label}</th><td className="py-2 text-end">{format(p.value)}</td></tr>)}</tbody>
   </table></div>;
 return <figure className="min-w-0 space-y-2 py-2">
  <figcaption className="text-[1.0625rem] font-medium leading-snug text-ink">{panel.title}</figcaption>
  {panel.coverage&&panel.source!=="response_evidence"&&<p id={coverageId} className="text-[0.8125rem] text-ink-muted">{confidence(panel.coverage)}</p>}
  {panel.kind==="metric"&&panel.points.length===1?<p className="wrap-break-word font-headline text-[1.875rem] font-medium leading-tight tracking-tight tabular-nums text-ink">{format(panel.points[0].value)}</p>:
   (panel.kind==="table"||panel.kind==="ranked_table"||panel.kind==="metric"||new Set(panel.points.map(p=>p.label)).size!==panel.points.length)?table:<><PresentationBoundary fallback={table}><Chart panel={panel.kind==="donut"&&(panel.points.some(p=>p.value<0)||panel.points.every(p=>p.value===0))?{...panel,kind:"bar"}:panel} format={format}/></PresentationBoundary>
    <details className="text-ink"><summary aria-label={detailsLabel+": "+panel.title} className="flex min-h-12 cursor-pointer items-center text-[0.9375rem] text-accent-text underline underline-offset-4 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ink">{detailsLabel}</summary>{table}</details></>}
  {panel.source==="response_evidence"?<p id={evidenceId} className="wrap-break-word text-[0.8125rem] text-ink-muted">{panel.sourceDetail}</p>:<p id={evidenceId} className="wrap-break-word text-[0.8125rem] leading-relaxed text-ink-muted">{panel.source!=="sql_research"&&<>{panel.from} – {panel.to} · </>}{panel.sourceDetail??(panel.source==="sql_research"?"":panel.source==="daily_rollups"?"Sales records":panel.source==="item_sales"?"Item sales":panel.source==="canonical_data"?panel.sourceDetail??"Canonical records":panel.source==="expenses"?"Recorded expenses":panel.source==="business_costs"?"Business costs":panel.source==="product_costs"?"Product economics":panel.source==="supplier_purchase_plan"?"Supplier quotes":panel.source==="purchase_orders"?"Purchase orders":panel.source==="inventory"?"Inventory":panel.source==="menu_items"?"Menu":"")} · {copy.snapshot} {panel.asOf}</p>}
 </figure>;
}
function ComparisonView({panels,locale}:{panels:PresentationPanel[];locale:string}){
 const evidenceId=useId();
 const first=panels[0],scalar=panels.every(p=>p.points.length===1);
 const series:ComparisonSeries[]=panels.map((p,i)=>({id:"s"+i,label:(i+1)+". "+p.title+" · "+p.from+" – "+p.to,points:p.points.map(v=>({label:scalar?"—":v.label,value:v.value}))}));
 const labels=[...new Set(series.flatMap(s=>s.points.map(v=>v.label)))];
 const line=panels.every(p=>p.kind==="line");
 if(line)labels.sort();
 const fmt=new Intl.NumberFormat(locale,["cents","cents/hour"].includes(first.unit)&&first.currency?{style:"currency",currency:first.currency,minimumFractionDigits:2,maximumFractionDigits:20}:{maximumFractionDigits:20});
 const format=(v:number)=>fmt.format(["cents","cents/hour"].includes(first.unit)?v/100:v);
 return <figure data-testid="supervisor-comparison" className="min-w-0 space-y-2 py-2">
  <PresentationBoundary><ComparisonChart series={series} labels={labels} line={line} format={format}/></PresentationBoundary>
  <div className="flex flex-wrap gap-3 text-[0.8125rem] text-ink-muted">{series.map(s=><span key={s.id}>{s.label}</span>)}</div>
  <div role="region" className="overflow-x-auto focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ink" tabIndex={0} aria-label={copy.comparisonValues}>
   <table aria-describedby={evidenceId} className="w-full text-[0.9375rem] tabular-nums"><caption className="sr-only">{copy.comparisonValues}</caption><thead><tr><th scope="col" className="py-2 text-start">{first.currency??first.measurement??first.unit}</th>{series.map(s=><th key={s.id} scope="col" className="px-2 text-end">{s.label}</th>)}</tr></thead>
    <tbody>{labels.map(label=><tr key={label}><th scope="row" className="py-2 text-start">{label}</th>{series.map(s=>{const v=s.points.find(p=>p.label===label);return <td key={s.id} className="px-2 text-end">{v?format(v.value):copy.notRecorded}</td>})}</tr>)}</tbody></table>
  </div>
  <div id={evidenceId}>{panels.map((p,i)=><p key={i} className="wrap-break-word text-[0.8125rem] text-ink-muted">{series[i].label}{p.source==="response_evidence"?(p.sourceDetail?" · "+p.sourceDetail:""):" · "+(p.sourceDetail??p.source)+" · "+copy.snapshot+" "+p.asOf+(p.coverage?" · "+confidence(p.coverage):"")}</p>)}</div>
 </figure>;
}
function AgendaView({agenda,locale}:{agenda:Agenda;locale:string}){
 // These are café-local civil dates, not timestamps. Format their calendar
 // fields at local noon; no hardcoded café timezone or conversion.
 const format=(day:string)=>{const [y,m,d]=day.split("-").map(Number);return new Intl.DateTimeFormat(locale,{dateStyle:"medium"}).format(new Date(y,m-1,d,12));}; // hardcode-ok: date-only café calendar labels, not timestamps; preserve the already-resolved calendar day in every viewer timezone.
 const status:Record<Agenda["entries"][number]["status"],string>=copy.eventStatuses;
 const [page,setPage]=useState(0);
 const [selected,setSelected]=useState<string|null>(null);
 const dateDetailsId=useId();
 const window=calendarPage(agenda,page);
 const current=window.days.find(d=>d.date===selected)??window.days.find(d=>d.entries.length)??window.days[0];
 return <section data-testid="supervisor-agenda" className="min-w-0 space-y-3 py-2">
  <h3 className="font-medium text-ink">{agenda.title}</h3>
  <p className="text-[0.8125rem] text-ink-muted">{format(agenda.from)} – {format(agenda.to)} · {copy.snapshot} {format(agenda.asOf)}{agenda.coverage==="partial"?" · "+copy.partial:""}</p>
  {agenda.kind==="calendar"?<>
    <div className="flex items-center justify-between gap-2 text-[0.9375rem]">
     <button type="button" aria-label={copy.previousDates} disabled={window.page===0} onClick={()=>{setPage(window.page-1);setSelected(null)}} className="min-h-12 min-w-12 rounded-lg border border-line disabled:opacity-40">‹</button>
     <span role="status" aria-atomic="true" className="text-center">{format(window.days[0].date)} – {format(window.days[window.days.length-1].date)}</span>
     <button type="button" aria-label={copy.nextDates} disabled={window.page+1===window.pages} onClick={()=>{setPage(window.page+1);setSelected(null)}} className="min-h-12 min-w-12 rounded-lg border border-line disabled:opacity-40">›</button>
    </div>
    <div role="group" tabIndex={0} data-testid="supervisor-calendar-grid" className="max-w-full overflow-x-auto overscroll-x-contain focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ink" aria-label={agenda.title}>
     <div className="grid min-w-[22.5rem] grid-cols-7 gap-1">
     {Array.from({length:7},(_,i)=><span key={i} className="text-center text-[0.8125rem] text-ink-muted">{new Intl.DateTimeFormat(locale,{weekday:"short"}).format(new Date(2024,0,7+i,12))}</span>)}
     {Array.from({length:window.days[0].weekday},(_,i)=><span key={"empty"+i} aria-hidden="true"/>)}
     {window.days.map(d=><button type="button" key={d.date} aria-label={format(d.date)+" · "+d.entries.length+" "+copy.savedEntries} aria-pressed={current.date===d.date} aria-controls={dateDetailsId} onClick={()=>setSelected(d.date)} className={"min-h-12 min-w-12 rounded-lg border px-0.5 py-1 text-center tabular-nums focus-visible:outline-solid focus-visible:outline-2 "+(current.date===d.date?"border-accent bg-surface2":"border-line")}>
      <span className="block text-[0.9375rem]">{Number(d.date.slice(-2))}</span><span className="block text-[0.8125rem] text-ink-muted">{d.entries.length?d.entries.length:"·"}</span>
     </button>)}
     </div>
    </div>
    <div id={dateDetailsId} aria-live="polite" aria-atomic="true">
    <h4 className="font-medium"><time dateTime={current.date}>{format(current.date)}</time></h4>
    {current.entries.length===0&&<p className="text-[0.9375rem] text-ink-muted">{copy.noSavedEntries}</p>}
    <ul className="space-y-2">{current.entries.map((e,i)=><li key={i} className="wrap-break-word border-s border-line ps-3">
      <p>{e.label}</p><p className="text-[0.8125rem] text-ink-muted">{e.start??copy.timeUnknown}{e.end?" – "+e.end:""}{e.endDate!==e.date?" · "+format(e.date)+" – "+format(e.endDate):""} · {status[e.status]}{e.endUnknown?" · "+copy.eventEndUnknown:""}{e.checkedAt?" · "+copy.snapshot+" "+e.checkedAt:""}</p>
    </li>)}</ul>
    </div>
  </>:<ol className="space-y-3 border-s border-line ps-4">{agenda.entries.map((e,i)=><li key={i} className="wrap-break-word">
   <time dateTime={e.date} className="text-[0.8125rem] text-ink-muted">{format(e.date)}{e.endDate!==e.date?" – "+format(e.endDate):""}</time>
   <p className="font-medium">{e.label}</p><p className="text-[0.8125rem] text-ink-muted">{e.start??copy.timeUnknown}{e.end?" – "+e.end:""} · {status[e.status]}{e.endUnknown?" · "+copy.eventEndUnknown:""}{e.checkedAt?" · "+copy.snapshot+" "+e.checkedAt:""}</p>
  </li>)}</ol>}
  <p className="text-[0.8125rem] text-ink-muted">{agenda.source==="cafe_events"?copy.eventNotice:copy.shiftNotice}</p>
 </section>;
}
function RecordTableView({table,locale}:{table:RecordTable;locale:string}){
 const evidenceId=useId(),scopeId=useId(),wide=table.columns.length>4;
 const fmt=(value:RecordTable["rows"][number][number],u:RecordTable["columns"][number]["unit"])=>{
  if(value===null)return copy.notRecorded;
  if(typeof value!=="number")return String(value);
  if(u==="cents"||u==="cents/hour")
   return (table.currency?new Intl.NumberFormat(locale,{style:"currency",currency:table.currency,minimumFractionDigits:2,maximumFractionDigits:20}).format(value/100):new Intl.NumberFormat(locale,{maximumFractionDigits:20}).format(value/100)+" (currency not set)")+(u==="cents/hour"?" / h":"");
  return new Intl.NumberFormat(locale,{maximumFractionDigits:20}).format(value);
 };
 return <figure data-testid="supervisor-record-table" className="min-w-0 space-y-2 py-2">
  <figcaption className="font-medium text-ink">{table.title}</figcaption>
  {table.view!=="tool_response_evidence"&&<p id={evidenceId} className="wrap-break-word text-[0.8125rem] text-ink-muted">{table.view==="tool_sql_research"?"SQL query":table.view} · {table.view!=="tool_sql_research"&&<>{table.from} – {table.to} · </>}{copy.snapshot} {table.asOf}{table.coverage!=="stored"&&table.coverage!=="authored"?" · "+confidence(table.coverage):""}</p>}
  <p id={scopeId} className="wrap-break-word text-[0.8125rem] text-ink-muted">{table.scope}</p>
  <div role="region" tabIndex={0} aria-label={table.title} className="max-w-full overflow-x-auto overscroll-x-contain focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ink">
   <table role="table" aria-describedby={table.view==="tool_response_evidence"?scopeId:evidenceId+" "+scopeId} className={"w-full table-auto text-[0.9375rem] tabular-nums "+(wide?wideResponseTableClass:"")}><caption className="sr-only">{table.title}</caption>
    <thead><tr>{table.columns.map((c,i)=><th key={i} scope="col" className="border-b border-line px-1.5 sm:px-2 py-2 text-start align-bottom font-medium wrap-anywhere">{c.label}<span className="block text-[0.8125rem] text-ink-muted">{c.unit==="stored"?copy.unitUnknown:c.unit==="microcents"?table.currency+" microcents":c.unit==="cents"?table.currency:c.unit==="cents/hour"?table.currency+" / h":c.unit}</span></th>)}</tr></thead>
    <tbody role="rowgroup">{table.rows.map((row,i)=><tr role="row" key={i}>{row.map((v,j)=>{
     const rowHeader=j===0&&["label","local date"].includes(table.columns[j].unit);
     const Tag=rowHeader?"th":"td";
     const cls="border-b border-line px-1.5 sm:px-2 py-2 text-start align-top wrap-break-word wrap-anywhere"+(rowHeader?" font-normal":"")+(wide?" "+wideResponseCellClass:"");
     const value=fmt(v,table.columns[j].unit);
     return <Tag key={j} role={rowHeader?"rowheader":"cell"} scope={rowHeader?"row":undefined} className={cls}>{wide?<><span aria-hidden="true" className={wideResponseLabelClass}>{table.columns[j].label}</span><span className="min-w-0 wrap-anywhere">{value}</span></>:value}</Tag>;
    })}</tr>)}</tbody>
   </table>
  </div>
 </figure>;
}
function CalculatorView({calculator,locale}:{calculator:InteractiveCalc;locale:string}){
 const resultId=useId();
 const [changes,setChanges]=useState<Record<string,string>>({});
 const outcome=evaluatePresentationCalc(calculator,changes);
 const number=(v:InteractiveCalc["original"])=>v.unit==="cents"?v.valueCents/100:v.unit==="percent"?v.valueBps/100:v.unit==="count"?v.quantity:v.valueRatio;
 const fmt=(v:InteractiveCalc["original"])=>v.unit==="cents"&&calculator.currency?
  new Intl.NumberFormat(locale,{style:"currency",currency:calculator.currency,minimumFractionDigits:2,maximumFractionDigits:20}).format(number(v)):
  new Intl.NumberFormat(locale,{maximumFractionDigits:4}).format(number(v))+(v.unit==="percent"?"%":"");
 return <section data-testid="supervisor-calculator" className="min-w-0 space-y-3 py-2">
  <h3 className="font-medium text-ink">{calculator.title}</h3>
  <p className="text-[0.8125rem] text-ink-muted">{copy.calculatorNotice} · {copy.snapshot} {calculator.asOf}</p>
  {calculator.inputs.map(i=>i.editable?<label key={i.id} className="block text-[0.9375rem]">
   {i.label}{i.value.unit==="cents"?" ("+(calculator.currency??"currency not set")+")":i.value.unit==="percent"?" (%)":""}
   <input aria-describedby={outcome?undefined:resultId} type="text" inputMode="decimal" value={changes[i.id]??String(number(i.value))} onChange={e=>setChanges(prev=>({...prev,[i.id]:e.target.value}))} className="mt-1 block min-h-12 w-full rounded-xl border border-line bg-surface px-3 tabular-nums"/>
  </label>:<p key={i.id} className="wrap-break-word text-[0.9375rem]">{i.label}: {fmt(i.value)}</p>)}
  <p role="status" aria-label={copy.calculationResult} aria-atomic="true" className="wrap-break-word text-xl font-medium tabular-nums"><span id={resultId}>{outcome?fmt(outcome):copy.invalidCalculation}</span></p>
  <button type="button" className="min-h-12 text-[0.9375rem] underline" onClick={()=>setChanges({})}>{copy.resetAssumptions}</button>
 </section>;
}
function ScenarioView({scenario,locale}:{scenario:ScenarioComparison;locale:string}){
 const resultId=useId();
 const [index,setIndex]=useState(0);
 const selected=scenario.cases[index]??scenario.cases[0];
 const [changes,setChanges]=useState<Record<string,string>>({});
 const edited=selected.editor?evaluateScenarioEditor(selected.editor,changes):null;
 const fmt=(v:number)=>new Intl.NumberFormat(locale,{style:"currency",currency:scenario.currency,minimumFractionDigits:2,maximumFractionDigits:20}).format(v/100);
 return <section data-testid="supervisor-scenario" className="min-w-0 space-y-3 py-2">
  <h3 className="font-medium text-ink">{scenario.title}</h3>
  <p className="text-[0.8125rem] text-ink-muted">{copy.estimate} · {copy.snapshot} {scenario.asOf}. {copy.noChange}</p>
  {scenario.cases.length>1?<label className="block text-[0.9375rem]">{copy.compareAssumptions}
   <select value={index} onChange={e=>{setIndex(Number(e.target.value));setChanges({});}} className="mt-1 block min-h-12 w-full rounded-xl border border-line bg-surface px-3">
    {scenario.cases.map((c,i)=><option value={i} key={i}>{c.assumption}</option>)}
   </select></label>:<p>{selected.assumption}</p>}
  {selected.editor&&<div data-testid="supervisor-scenario-editor" className="space-y-2">
    <p className="text-[0.8125rem] text-ink-muted">{copy.calculatorNotice}</p>
    {scenarioEditFields(selected.editor).map(f=><label key={f.key} className="block text-[0.9375rem]">{copy.scenarioEditFields[f.key as keyof typeof copy.scenarioEditFields]??f.label}{f.money?" ("+scenario.currency+")":f.percent?" (%)":""}
      <input aria-describedby={edited?undefined:resultId} type="text" inputMode="decimal" maxLength={15} value={changes[f.key]??String(f.value)} onChange={e=>setChanges(prev=>({...prev,[f.key]:e.target.value}))} className="mt-1 block w-full min-h-12 rounded-xl border border-line bg-surface px-3 tabular-nums"/>
    </label>)}
    <button type="button" className="min-h-12 underline text-[0.9375rem]" onClick={()=>setChanges({})}>{copy.resetAssumptions}</button>
  </div>}
  <dl className="grid grid-cols-2 gap-2 tabular-nums">
   <div><dt className="text-[0.8125rem] text-ink-muted">{copy.baselineEstimate}</dt><dd className="wrap-break-word text-xl font-medium">{fmt(selected.beforeCents)}</dd></div>
   <div><dt className="text-[0.8125rem] text-ink-muted">{copy.scenarioEstimate}</dt><dd className="wrap-break-word text-xl font-medium"><span role="status" aria-label={copy.scenarioEstimate} aria-atomic="true"><span id={resultId}>{selected.editor?edited?fmt(edited.afterCents):copy.invalidCalculation:fmt(selected.afterCents)}</span></span></dd></div>
  </dl>
  {!selected.editor&&<p className="text-[0.8125rem] text-ink-muted">{copy.scenarioNotice}</p>}
 </section>;
}
type ControlContext={data:RichPresentation;message?:Parameters<typeof presentationReport>[1]&{threadId:string;id:string};attachments?:{threadId:string;items:StoredAttachment[]}|null;onSuggest:(text:string)=>void;disabled:boolean};
const PresentationControls=createContext<ControlContext|null>(null);
function ControlView({kind}:{kind:unknown}){
 const context=useContext(PresentationControls);
 if(!context)return null;
 const {data,message,attachments,onSuggest,disabled}=context;
 const documentIndex=data.pdfSpec?message?.blocks?.findIndex(block=>block&&typeof block==="object"&&"pdfSpec" in block&&JSON.stringify(block.pdfSpec)===JSON.stringify(data.pdfSpec))??-1:-1;
 const pdfHref=message?"/api/ai/threads/"+encodeURIComponent(message.threadId)+"/messages/"+encodeURIComponent(message.id)+"/report"+(documentIndex>=0?"?document="+documentIndex:""):null;
 const download=()=>{
  if(!message||!data.report)return;
  const url=URL.createObjectURL(new Blob([presentationReport(data,message)],{type:"text/plain;charset=utf-8"}));
  const anchor=document.createElement("a");anchor.href=url;anchor.download="supervisor-report.txt";anchor.click();
  // The browser owns the local download; release the in-memory snapshot afterwards.
  setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
 return <>
  {kind==="files"&&!!data.files?.length&&message&&<section aria-label={copy.sourceAttachments} className="space-y-2">
    <h3 className="text-[0.9375rem] font-medium text-ink-muted">{copy.sourceAttachments}</h3>
    {data.files.map((id,i)=>{const file=attachments?.threadId===message.threadId?attachments.items.find(f=>f.id===id):null;
     return <a key={id} href={"/api/ai/threads/"+encodeURIComponent(message.threadId)+"/attachments/"+encodeURIComponent(id)} target="_blank" rel="noopener noreferrer" className="flex min-h-12 min-w-0 items-center gap-2 rounded-lg border border-line px-3 text-[0.9375rem] text-ink underline"><Paperclip size={17} className="shrink-0" aria-hidden="true"/><span className="min-w-0 break-all">{file?.originalName??copy.sourceFile+" "+(i+1)}</span></a>;
    })}
  </section>}
  {kind==="report"&&data.report&&message&&<div className="flex flex-wrap gap-2">{pdfHref&&<a href={pdfHref} download className="inline-flex min-h-12 items-center rounded-xl border border-line px-4 text-[0.9375rem] font-medium text-ink hover:bg-surface2">{copy.downloadPdf}</a>}<button type="button" onClick={download} className="min-h-12 rounded-xl border border-line px-4 text-start text-[0.9375rem] font-medium text-ink hover:bg-surface2">{copy.downloadReport}</button></div>}
  {kind==="report"&&data.report&&!message&&<p role="status" className="text-sm text-ink-muted">{copy.reportPreparing}</p>}
  {kind==="suggestions"&&data.suggestions.length>0&&<div className="flex flex-wrap gap-2">{data.suggestions.map(prompt=><button key={prompt} type="button" disabled={disabled} onClick={()=>onSuggest(prompt)} className="min-h-12 max-w-full rounded-full border border-line px-4 py-2 text-start text-[0.9375rem] leading-snug text-ink hover:bg-surface2 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">{prompt}</button>)}</div>}
 </>;
}
const nativeCatalog=defineCatalog(schema,{components:{...upstreamComponents,LunaChart:nativeChartDefinition,LunaSnapshot:{props:z.object({snapshotJSON:z.string()}),slots:[],description:"Resolved authenticated data view"},LunaFallback:{props:z.object({widget:z.string(),values:z.unknown()}),slots:["default"],description:"Inert authored values"}},actions:{}});
/** The installed registry is used wholesale. Wrap resolved props for the one
 * browser trust boundary, not a second manually curated widget library. */
/** A display failure is never an instruction to suppress authored values.
 * Render inert text, not active HTML, network URLs or widget actions. */
function AuthoredValues({value}:{value:unknown}){
 const display=(v:unknown):string=>typeof v==="string"?v:v==null?"Not recorded":JSON.stringify(v,null,2)??String(v);
 if(value&&typeof value==="object"&&!Array.isArray(value)){
  const data=value as Record<string,unknown>;
  const rawRows=Array.isArray(data.rows)?data.rows:Array.isArray(data.points)?data.points:undefined;
  if(rawRows?.length){
   const {columns,rows}=normalizeTableData(data.columns,rawRows);
   const width=columns.length;
   const rest=Object.fromEntries(Object.entries(data).filter(([k])=>!["rows","points","columns"].includes(k)));
   return <div className="min-w-0 space-y-2"><AuthoredValues value={rest}/><div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr>{Array.from({length:width},(_,i)=><th key={i} className="border-b border-line p-2 text-start">{columns[i]??"Value "+(i+1)}</th>)}</tr></thead><tbody>{rows.map((row,i)=><tr key={i}>{Array.from({length:width},(_,j)=><td key={j} className="border-b border-line p-2 whitespace-pre-wrap">{display(row[j])}</td>)}</tr>)}</tbody></table></div></div>;
  }
  return <dl className="min-w-0 space-y-2">{Object.entries(value).map(([key,v])=><div key={key} className="min-w-0"><dt className="text-sm font-medium text-ink-muted">{key}</dt><dd className="whitespace-pre-wrap wrap-break-word">{display(v)}</dd></div>)}</dl>;
 }
 return <p className="whitespace-pre-wrap wrap-break-word">{display(value)}</p>;
}
function NativeSpecValues({spec}:{spec:Spec}){
 return <div className="min-w-0 space-y-3">{Object.entries(spec.elements).map(([key,e])=><section key={key}><h3 className="font-medium">{e.type}</h3><AuthoredValues value={e.props}/></section>)}{spec.state&&<AuthoredValues value={spec.state}/>}</div>;
}
function NativeSnapshot({value,locale}:{value:unknown;locale:string}){
 const context=useContext(PresentationControls);
 if(!context)return null;
 const snapshot=recoverRichPresentation(readNativeSnapshot(value));
 if(!snapshot)return <AuthoredValues value={readNativeSnapshot(value)??value}/>;
 return <SupervisorRichPresentation block={snapshot} locale={locale} onSuggest={context.onSuggest} disabled={context.disabled} message={context.message} attachments={context.attachments}/>;
}
function NamedNativeControl({label,role,children}:{label:string;role:string;children:React.ReactNode}){
 return <div className="contents" ref={node=>{
  // Upstream's visible label is not associated with these Radix controls.
  // Keep the upstream implementation and attach its existing label.
  const control=node?.querySelector('[role="'+role+'"]');
  if(control&&!control.hasAttribute("aria-labelledby"))control.setAttribute("aria-label",label);
 }}>{children}</div>;
}
/** Use the upstream Grid for its authored styles and gap, but let the
 * browser's intrinsic flex layout determine how many tracks fit. No device
 * breakpoints, maximum column count, or prescribed minimum card width. */
function AdaptiveGrid({columns,children}:{columns:unknown;children:ReactNode}){
 const ref=useRef<HTMLDivElement>(null);
 const preferred=typeof columns==="number"&&Number.isFinite(columns)&&columns>=1?Math.floor(columns):undefined;
 useLayoutEffect(()=>{
  const container=ref.current,grid=container?.firstElementChild;
  if(!container||!grid)return;
  const sync=()=>{
   const gap=getComputedStyle(grid).columnGap;
   const value=gap==="normal"?"0px":gap;
   if(container.style.getPropertyValue("--luna-gap")!==value)container.style.setProperty("--luna-gap",value);
  };
  sync();const observer=new ResizeObserver(sync);observer.observe(grid);return()=>observer.disconnect();
 });
 const style=preferred?{"--luna-track":"max(0px, calc((100% - ("+preferred+" - 1) * var(--luna-gap, 0px)) / "+preferred+"))"} as CSSProperties:undefined;
 return <div ref={ref} data-testid="luna-adaptive-grid" className="luna-adaptive-flow min-w-0" style={style}>{children}</div>;
}
function NativeWidget({spec,locale}:{spec:Spec;locale:string}){
 // A polling parent may reconstruct an equal message object. The keyed
 // widget survives that refresh without resetting edits or keyboard focus.
 const [store]=useState(()=>createLocalWidgetStore(spec.state));
 const registry=useMemo(()=>{
  const {registry}=defineRegistry(nativeCatalog,{components:{...shadcnComponents,
   LunaChart:({props})=>{
    const p=nativeChartProps.safeParse(props);
    if(!p.success)return <AuthoredValues value={{title:props.title,description:props.description,points:props.points,unit:props.unit,currency:props.currency}}/>;
    const {description,measurement,asOf,...values}=p.data;
    const points=values.points.flatMap(point=>point.value===null?[]:[{...point,value:point.value}]);
    // A date or a provenance contract is not required for an authored chart.
    // Unknown values remain visible instead of being plotted as zero.
    if(points.length===values.points.length)return <Panel panel={{...values,points,source:"response_evidence",...(asOf?{asOf}:{}),...(description?{sourceDetail:description}:{}),...(measurement?{measurement}:{})}} locale={locale}/>;
    const format=(value:number|null)=>{
     if(value===null)return copy.notRecorded;
     const monetary=values.unit==="cents"||values.unit==="cents/hour";
     try{return new Intl.NumberFormat(locale,monetary&&values.currency?{style:"currency",currency:values.currency}:{maximumFractionDigits:20}).format(monetary?value/100:value)+(values.unit==="cents/hour"?" / h":"");}
     catch{return [String(monetary?value/100:value),values.currency].filter(Boolean).join(" ");}
    };
    return <figure className="min-w-0 space-y-2"><figcaption className="font-medium">{values.title}</figcaption>{description&&<p className="text-sm text-ink-muted">{description}</p>}<div className="overflow-x-auto"><table className="w-full table-auto text-sm"><thead><tr><th scope="col" className="text-start">{copy.categoryLabel}</th><th scope="col" className="text-end">{measurement??values.unit}</th></tr></thead><tbody>{values.points.map((point,i)=><tr key={i}><th scope="row" className="text-start font-normal">{point.label}</th><td className="text-end">{format(point.value)}</td></tr>)}</tbody></table></div></figure>;
   },
   LunaSnapshot:({props})=><NativeSnapshot value={props.snapshotJSON} locale={locale}/>,
   LunaFallback:({props,children})=><div className="min-w-0 space-y-2"><AuthoredValues value={props.values}/>{children}</div>,
  }});
  for(const name of Object.keys(registry)){
   if(!Object.hasOwn(upstreamComponents,name))continue;
   const Component=registry[name];
   registry[name]=input=>{
    const parsed=parseUpstreamProps(name,input.element.props);
    if(!parsed?.success)return <div className="min-w-0"><AuthoredValues value={input.element.props}/>{input.children}</div>;
    const component=<PresentationBoundary fallback={<div className="min-w-0"><AuthoredValues value={input.element.props}/>{input.children}</div>}><Component {...input} element={{...input.element,props:parsed.data}}/></PresentationBoundary>;
    const role=name==="Slider"?"slider":name==="Select"?"combobox":name==="Radio"?"radiogroup":null;
    const label="label" in parsed.data&&typeof parsed.data.label==="string"?parsed.data.label:name;
    if(name==="Grid")return <AdaptiveGrid columns={"columns" in parsed.data?parsed.data.columns:undefined}>{component}</AdaptiveGrid>;
    if(name==="Table")return <div className="luna-responsive-table min-w-0 max-w-full overflow-x-auto">{component}</div>;
    return role?<NamedNativeControl role={role} label={label}>{component}</NamedNativeControl>:component;
   };
  }
  return registry;
 },[locale]);
 return <div className="min-w-0 max-w-full" data-testid="luna-native-widget"><JSONUIProvider registry={registry} store={store} functions={nativeFunctions}><Renderer spec={spec} registry={registry} fallback={({children})=><div className="min-w-0"><p role="status">This part of the answer could not be displayed.</p>{children}</div>}/></JSONUIProvider></div>;
}
export default function SupervisorRichPresentation({block,locale,onSuggest=()=>{},disabled,message,attachments}:{block:unknown;locale:string;onSuggest?:(text:string)=>void;disabled:boolean;message?:Parameters<typeof presentationReport>[1]&{threadId:string;id:string};attachments?:{threadId:string;items:StoredAttachment[]}|null}){
 const data=useMemo(()=>recoverRichPresentation(block),[block]);
 const registry=useMemo<ComponentRegistry>(()=>({
  Layout:({element,children})=>{
   const title=typeof element.props.title==="string"?element.props.title:null;
   if(element.props.layout==="details"&&title)return <details data-supervisor-layout="details" className="min-w-0 space-y-2"><summary className="min-h-12 cursor-pointer wrap-break-word py-3 text-[1.0625rem] font-medium text-ink focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-ink">{title}</summary>{children}</details>;
   return <div data-supervisor-layout={element.props.layout==="grid"?"grid":"stack"} className="min-w-0 space-y-2">
    {title&&<h3 className="wrap-break-word text-[1.0625rem] font-medium text-ink">{title}</h3>}
    <div className={element.props.layout==="grid"?"luna-adaptive-flow-content min-w-0 gap-3":"min-w-0 space-y-3"}>{children}</div>
   </div>;
  },
  Panel:({element})=>{const p=presentationPanelSchema.safeParse(element.props.panel);return p.success?<Panel panel={p.data} locale={locale}/>:null;},
  Comparison:({element})=>{const raw:unknown=element.props.panels;const p=Array.isArray(raw)?raw.map((v:unknown)=>presentationPanelSchema.safeParse(v)):[];if(p.some(v=>!v.success))return null;const panels=p.flatMap(v=>v.success?[v.data]:[]);return compatibleComparison(panels.map((_,i)=>"panel"+i),panels)?<div className="min-w-0">{typeof element.props.title==="string"&&<h3 className="wrap-break-word text-[1.0625rem] font-medium text-ink">{element.props.title}</h3>}<ComparisonView panels={panels} locale={locale}/></div>:null;},
  Agenda:({element})=>{const a=agendaSchema.safeParse(element.props.agenda);return a.success?<AgendaView agenda={a.data} locale={locale}/>:null;},
  Scenario:({element})=>{const s=scenarioComparisonSchema.safeParse(element.props.scenario);return s.success?<ScenarioView scenario={s.data} locale={locale}/>:null;},
  RecordTable:({element})=>{const t=recordTableSchema.safeParse(element.props.table);return t.success?<RecordTableView table={t.data} locale={locale}/>:null;},
  Control:({element})=><ControlView kind={element.props.kind}/>,
  Calculator:({element})=>{const c=interactiveCalcSchema.safeParse(element.props.calculator);return c.success?<CalculatorView calculator={c.data} locale={locale}/>:null;},
 }),[locale]);
 if(!data)return <AuthoredValues value={block}/>;
 const composed=Boolean(data.groups?.some(g=>g.id));
 return <PresentationControls.Provider value={{data,message,attachments,onSuggest,disabled}}><section className="min-w-0 space-y-3" data-testid="supervisor-rich-presentation">
  {data.nativeSpec&&<PresentationBoundary fallback={<NativeSpecValues spec={data.nativeSpec}/>}><NativeWidget key={JSON.stringify(data.nativeSpec)} spec={data.nativeSpec} locale={locale}/></PresentationBoundary>}
  {(presentationLeaves(data).length>0||composed)&&<PresentationBoundary fallback={<div className="space-y-3">{data.panels.map((p,i)=><Panel key={i} panel={{...p,kind:"table"}} locale={locale}/>)}{data.tables?.map((t,i)=><RecordTableView key={i} table={t} locale={locale}/>)}{data.calculator&&<CalculatorView calculator={data.calculator} locale={locale}/>}<p role="status">Visual layout unavailable; available values are shown above.</p></div>}><JSONUIProvider registry={registry}><Renderer spec={presentationSpec(data)} registry={registry}/></JSONUIProvider></PresentationBoundary>}
  {!composed&&<><ControlView kind="files"/><ControlView kind="report"/><ControlView kind="suggestions"/></>}
 </section></PresentationControls.Provider>;
}
