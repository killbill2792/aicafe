import Link from "next/link";
import { listConversations } from "@/lib/admin/data.server";
export const dynamic="force-dynamic";
type Filters={cafe?:string;from?:string;to?:string;failed?:string;slow?:string;down?:string};
export default async function ConversationsPage({searchParams}:{searchParams:Promise<Filters>}){
  const q=await searchParams; const turns=await listConversations({...q,failed:q.failed==="1",slow:q.slow==="1",down:q.down==="1"});
  return <section><h1 className="mb-4 text-2xl font-bold">Conversation troubleshooting</h1>
    <form className="mb-5 flex flex-wrap items-end gap-3 rounded-xl border bg-white p-4" method="get">
      <label className="flex flex-col text-sm">Cafe ID<input className="rounded border p-2" type="text" name="cafe" defaultValue={q.cafe??""}/></label>
      <label className="flex flex-col text-sm">From (UTC)<input className="rounded border p-2" type="date" name="from" defaultValue={q.from}/></label>
      <label className="flex flex-col text-sm">To (UTC)<input className="rounded border p-2" type="date" name="to" defaultValue={q.to}/></label>
      <label className="flex items-center gap-2"><input type="checkbox" name="failed" value="1" defaultChecked={q.failed==="1"}/> Failed</label>
      <label className="flex items-center gap-2"><input type="checkbox" name="slow" value="1" defaultChecked={q.slow==="1"}/> Over 20s</label>
      <label className="flex items-center gap-2"><input type="checkbox" name="down" value="1" defaultChecked={q.down==="1"}/> Thumbs down</label>
      <button className="rounded bg-slate-900 px-4 py-2 text-white">Filter</button>
    </form>
    <div className="space-y-2">{turns.map(t=><Link key={t.id} href={`/admin/conversations/${t.id}`} className="block rounded-lg border bg-white p-4 hover:border-blue-400">
      <div className="flex flex-wrap justify-between gap-2 text-sm"><span className="font-semibold">{t.status.toUpperCase()} · {t.duration_ms} ms {t.owner_feedback?"· "+t.owner_feedback:""}</span><time>{t.started_at}</time></div>
      <p className="mt-2 line-clamp-2 break-words">{t.question}</p><p className="mt-1 text-xs text-slate-500">Cafe {t.business_id}</p>
    </Link>)}{!turns.length&&<p>No conversations match these filters.</p>}</div>
  </section>;
}
