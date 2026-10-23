import Link from "next/link";
import { notFound } from "next/navigation";
import { getConversation } from "@/lib/admin/data.server";
export const dynamic="force-dynamic";
export default async function TurnPage({params}:{params:Promise<{turnId:string}>}){
  const {turnId}=await params;const t=await getConversation(turnId);if(!t)notFound();
  return <section className="space-y-5"><Link className="text-blue-700 underline" href="/admin/conversations">← Conversations</Link>
    <h1 className="text-2xl font-bold">Turn timeline</h1>
    <div className="rounded-lg border bg-white p-4"><p className="font-semibold">{t.status} · {t.duration_ms} ms</p>
      <p className="text-sm">{t.started_at} – {t.ended_at}</p>
      <p className="text-sm">Model: {t.model??"Unknown"} · Tokens: {t.input_tokens??"?"} in / {t.output_tokens??"?"} out · Cost: {t.cost_usd==null?"Not configured":`$${t.cost_usd}`}</p>
      <p className="text-sm">Owner feedback: {t.owner_feedback??"None"} {t.owner_feedback_comment??""}</p>
      {t.error_text&&<p className="mt-2 text-red-700">Error: {t.error_text}</p>}
    </div>
    <div className="rounded-lg border bg-white p-4"><h2 className="font-semibold">Owner question</h2><p className="mt-2 whitespace-pre-wrap break-words">{t.question}</p></div>
    <ol className="space-y-3 border-s-2 border-slate-300 ps-5">{t.steps.map(step=><li key={step.id} className="rounded-lg border bg-white p-4">
      <h2 className="font-semibold">{step.step_order}. {step.kind.replace("_"," ")} {step.tool_name??""} · {step.duration_ms??"?"} ms</h2>
      <p className="text-sm">{step.input_summary??""}</p><p className="text-sm">{step.output_summary??""}</p>
      {step.error&&<p className="font-semibold text-red-700">{step.error}</p>}
    </li>)}</ol>
    <div className="rounded-lg border bg-white p-4"><h2 className="font-semibold">Final answer</h2><p className="mt-2 whitespace-pre-wrap break-words">{t.final_answer??"No answer persisted"}</p></div>
    <div className="text-sm">Retry of: {t.retry_of?<Link className="text-blue-700 underline" href={`/admin/conversations/${t.retry_of}`}>{t.retry_of}</Link>:"None"} · Retried by: {t.retries.length?t.retries.map(r=><Link key={r.id} className="ms-2 text-blue-700 underline" href={`/admin/conversations/${r.id}`}>{r.started_at} ({r.status})</Link>):"None"}</div>
  </section>;
}
