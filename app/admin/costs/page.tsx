import Link from "next/link";
import {getAdminCosts,type CostGroup,type CostMetric} from "@/lib/admin/analytics.server";
import {topicLabels} from "@/lib/admin/topics";
import {displayKnownCost} from "@/lib/admin/format";
export const dynamic="force-dynamic";
function Metrics({item}:{item:CostMetric}){
  return <span>{item.turns.toLocaleString("en-US")} turns · {item.input_tokens.toLocaleString("en-US")} input / {item.output_tokens.toLocaleString("en-US")} output tokens · {displayKnownCost(Number(item.known_cost_usd),item.priced_turns,item.turns)}</span>;
}
function Table({title,rows,label}:{title:string;rows:CostGroup[];label:(g:CostGroup)=>React.ReactNode}){
  return <section className="space-y-2"><h2 className="text-xl font-semibold">{title}</h2>
    <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm">
      <thead><tr className="bg-slate-100"><th className="p-3">Group</th><th className="p-3">Usage and cost</th></tr></thead>
      <tbody>{rows.map((r,i)=><tr key={i} className="border-t"><th className="p-3">{label(r)}</th><td className="p-3"><Metrics item={r}/></td></tr>)}</tbody>
    </table></div>{!rows.length&&<p>No recorded turns.</p>}</section>;
}
export default async function AdminCosts(){
  const values=await getAdminCosts();
  return <div className="space-y-7"><header><h1 className="text-2xl font-bold">AI usage and cost</h1>
    <p className="text-sm text-slate-600">UTC calendar days. Costs are estimates from explicitly configured rates; unpriced turns are counted but excluded from cost totals.</p></header>
    <div className="rounded-xl border bg-white p-5"><h2 className="font-semibold">Recorded totals</h2><Metrics item={values.totals}/></div>
    <Table title="Per cafe" rows={values.cafes} label={r=><Link className="text-blue-700 underline" href={`/admin/conversations?cafe=${r.business_id}`}>{r.name??r.business_id}</Link>}/>
    <Table title="Per day (UTC)" rows={values.days} label={r=>r.day}/>
    <Table title="Per question type" rows={values.topics} label={r=>topicLabels[r.topic??""]??r.topic}/>
    <section><h2 className="mb-2 text-xl font-semibold">10 costliest priced turns</h2>
      <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm">
        <thead className="bg-slate-100"><tr>{["Turn","Cafe","Date","Topic","Tokens","Estimated cost"].map(t=><th className="p-3" key={t}>{t}</th>)}</tr></thead>
        <tbody>{values.top_turns.map(r=><tr className="border-t" key={r.id}>
          <td className="p-3"><Link className="text-blue-700 underline" href={`/admin/conversations/${r.id}`}>Open turn</Link></td>
          <td className="p-3">{r.name}</td><td className="p-3">{r.started_at.slice(0,10)}</td>
          <td className="p-3">{topicLabels[r.question_topic??"pending_classification"]??r.question_topic}</td>
          <td className="p-3">{r.input_tokens??"?"} / {r.output_tokens??"?"}</td>
          <td className="p-3">{displayKnownCost(Number(r.cost_usd),1,1)}</td>
        </tr>)}</tbody></table></div>{!values.top_turns.length&&<p>No priced turns yet. Set approved model rates before claiming totals.</p>}</section>
  </div>;
}
