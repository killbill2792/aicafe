import {getAdminPatterns} from "@/lib/admin/analytics.server";
import {topicLabels,homeCardCandidates} from "@/lib/admin/topics";
import {displayAverageCost} from "@/lib/admin/format";
import MakeHomeCardButton from "@/components/admin/MakeHomeCardButton";
export const dynamic="force-dynamic";
export default async function PatternsPage(){
  const result=await getAdminPatterns();
  return <div className="space-y-6"><header><h1 className="text-2xl font-bold">Question patterns</h1>
    <p className="text-sm text-slate-600">Last 90 days. Daily classification uses fixed multilingual topic rules. Peak hour is cafe-local time, not UTC. Cost averages exclude unpriced turns.</p>
    <p className="text-sm text-slate-600">{result.pending} questions awaiting the next daily classification.</p></header>
    <section className="space-y-3">{result.topics.map(t=><article key={t.topic} className="rounded-xl border bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{topicLabels[t.topic]??t.topic}</h2>
        <p className="text-sm">{t.questions} questions · {t.cafes} cafes · Common time {t.common_local_hour==null?"Unknown":`${String(t.common_local_hour).padStart(2,"0")}:00–${String(t.common_local_hour).padStart(2,"0")}:59`}</p>
        <p className="text-sm">Avg estimated cost: {displayAverageCost(t.avg_cost_usd===null?null:Number(t.avg_cost_usd),t.priced_questions,t.questions)}</p></div>
        {homeCardCandidates.has(t.topic)&&<div className="space-y-1"><p className="text-xs font-medium text-slate-600">Candidate for a data-backed Home card (review required)</p>
          <MakeHomeCardButton topic={t.topic} alreadySuggested={result.suggestions.includes(t.topic)}/></div>}
      </div></article>)}
      {!result.topics.length&&<p>No classified questions yet. The first daily cron run will populate these topics.</p>}
    </section><section><h2 className="mb-3 text-xl font-semibold">Daily topic counts (UTC)</h2>
      <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm"><thead className="bg-slate-100"><tr><th className="p-3">Date</th><th className="p-3">Topic</th><th className="p-3">Questions</th><th className="p-3">Cafes</th></tr></thead>
      <tbody>{result.daily.map((d,i)=><tr key={i} className="border-t"><td className="p-3">{d.day}</td><td className="p-3">{topicLabels[d.topic]??d.topic}</td><td className="p-3">{d.questions}</td><td className="p-3">{d.cafes}</td></tr>)}</tbody></table></div>
    </section>
  </div>;
}
