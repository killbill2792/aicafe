"use client";
import {Bar,BarChart,CartesianGrid,Cell,Line,LineChart,Pie,PieChart,ResponsiveContainer,Tooltip,XAxis,YAxis,Legend} from "recharts";
import type {PresentationPanel} from "@/lib/ai/conversations/presentation";

const ink="rgb(var(--c-muted))";
const accent="rgb(var(--c-accent))";
const palette=[accent,"rgb(var(--c-chart-staff))","rgb(var(--c-chart-ingredients))","rgb(var(--c-chart-running))","rgb(var(--c-chart-fees))"];
export default function SupervisorRichChart({panel,format}:{panel:PresentationPanel;format:(value:number)=>string}){
 const data=panel.points.map(p=>({name:p.label,value:p.value}));
 const common=<><CartesianGrid vertical={false} stroke="rgb(var(--c-line))"/>
   <XAxis dataKey="name" tick={{fontSize:13,fill:ink}} tickLine={false} axisLine={false} minTickGap={16}/>
   <YAxis tickFormatter={format} width={80} tick={{fontSize:13,fill:ink}} axisLine={false} tickLine={false}/>
   <Tooltip formatter={value=>format(Number(value))} contentStyle={{background:"rgb(var(--c-surface))",color:"rgb(var(--c-text))",borderColor:"rgb(var(--c-line))",borderRadius:12}}/></>;
 // The exact data table is adjacent. The decorative chart has no hidden
 // keyboard targets or simulated animation and never asserts another fact.
 return <div aria-hidden="true" data-testid="supervisor-rich-chart" className="h-52 w-full min-w-0 overflow-hidden text-ink-muted sm:h-60">
  <ResponsiveContainer width="100%" height="100%">
   {panel.kind==="line"?<LineChart data={data} accessibilityLayer={false} margin={{top:10,right:8,bottom:4,left:0}}>{common}<Line dataKey="value" stroke={accent} strokeWidth={2} dot={false} isAnimationActive={false}/></LineChart>:
    panel.kind==="donut"?<PieChart accessibilityLayer={false}><Tooltip formatter={value=>format(Number(value))}/><Pie data={data} dataKey="value" nameKey="name" innerRadius="50%" outerRadius="80%" stroke="rgb(var(--c-surface))" isAnimationActive={false}>{data.map((_,i)=><Cell key={i} fill={palette[i%palette.length]}/>)}</Pie></PieChart>:
    <BarChart accessibilityLayer={false} data={data} margin={{top:10,right:8,bottom:4,left:0}}>{common}<Bar dataKey="value" fill={accent} radius={[4,4,0,0]} isAnimationActive={false}/></BarChart>}
  </ResponsiveContainer>
 </div>;
}

export type ComparisonSeries={id:string;label:string;points:{label:string;value:number}[]};
export function ComparisonChart({series,labels,line,format}:{series:ComparisonSeries[];labels:string[];line:boolean;format:(value:number)=>string}){
 const data=labels.map(label=>({name:label,...Object.fromEntries(series.map(s=>[s.id,s.points.find(p=>p.label===label)?.value??null]))}));
 const axes=<><CartesianGrid vertical={false} stroke="rgb(var(--c-line))"/><XAxis dataKey="name" tick={{fontSize:13,fill:ink}} minTickGap={16}/><YAxis tickFormatter={format} width={80} tick={{fontSize:13,fill:ink}}/><Tooltip formatter={v=>format(Number(v))}/><Legend/></>;
 return <div aria-hidden="true" className="h-64 min-w-0 w-full overflow-hidden" data-testid="supervisor-comparison-chart"><ResponsiveContainer width="100%" height="100%">
 {line?<LineChart accessibilityLayer={false} data={data}>{axes}{series.map((s,i)=><Line key={s.id} dataKey={s.id} name={s.label} stroke={palette[i%palette.length]} strokeWidth={2} connectNulls={false} isAnimationActive={false}/>)}</LineChart>:
 <BarChart accessibilityLayer={false} data={data}>{axes}{series.map((s,i)=><Bar key={s.id} dataKey={s.id} name={s.label} fill={palette[i%palette.length]} isAnimationActive={false}/>)}</BarChart>}
 </ResponsiveContainer></div>;
}
