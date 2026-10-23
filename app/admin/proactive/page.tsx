import Link from "next/link";
import {getAdminProactive} from "@/lib/admin/analytics.server";
export const dynamic="force-dynamic";
export default async function ProactivePage({searchParams}:{searchParams:Promise<{cafe?:string}>}){
  const {cafe}=await searchParams;
  const data=await getAdminProactive(cafe);
  const all=[...data.recent_updates.map(item=>({id:item.id,business_id:item.business_id,created_at:item.created_at,
    channel:"In-app update",kind:`${item.domain} · ${item.kind}`,
    sent:"Created (in-app)",opened:item.status==="new"?"Not yet marked opened":"Opened or handled",
    acted:item.status==="acted"?"Acted":item.status==="dismissed"?"Dismissed":"Not recorded",description:item.text})),
    ...data.recent_deliveries.map(item=>({id:item.id,business_id:item.business_id,created_at:item.created_at,
      channel:"WhatsApp attempt",kind:item.task_id,
      sent:item.state==="sent"?"Provider accepted":item.state==="failed"?"Failed":"Reserved",
      opened:"Unknown (no read receipt)",acted:"Unknown (not tracked)",description:item.failure_code??""}))]
    .sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,150);
  return <div className="space-y-6"><header><h1 className="text-2xl font-bold">Proactive alerts and suggestions</h1>
    <p className="text-sm text-slate-600">In-app updates are created by the app (not necessarily pushed). Opening is inferred from the update status. WhatsApp “sent” means provider acceptance only; opens and attributable actions are not tracked.</p></header>
    <form className="flex flex-wrap items-end gap-3 rounded-xl border bg-white p-3" method="get">
      <label className="flex flex-col text-sm">Cafe UUID<input className="rounded border p-2" name="cafe" type="text" defaultValue={cafe??""}/></label>
      <button className="min-h-12 rounded-lg bg-slate-900 px-4 text-white">Filter</button>
      <Link href="/admin/proactive" className="rounded border p-3">Clear</Link>
    </form>
    <section><h2 className="mb-3 text-xl font-semibold">Per cafe · all-time counts</h2>
      <div className="overflow-x-auto rounded-xl border bg-white"><table className="w-full text-left text-sm">
        <thead className="bg-slate-100"><tr>{["Cafe","In-app created","Marked opened / handled","Acted","Dismissed","WhatsApp accepted","WhatsApp failed","Reserved"].map(s=><th className="p-3" key={s}>{s}</th>)}</tr></thead>
        <tbody>{data.cafes.map(c=><tr key={c.business_id} className="border-t">
          <td className="p-3"><Link className="text-blue-700 underline" href={`/admin/cafes/${c.business_id}`}>{c.name}</Link></td>
          <td className="p-3">{c.in_app_created}</td><td className="p-3">{c.in_app_opened}</td><td className="p-3">{c.in_app_acted}</td><td className="p-3">{c.in_app_dismissed}</td>
          <td className="p-3">{c.outbound_sent}</td><td className="p-3">{c.outbound_failed}</td><td className="p-3">{c.outbound_pending}</td>
        </tr>)}</tbody></table></div></section>
    <section><h2 className="mb-3 text-xl font-semibold">Recent activity (up to 100 per source)</h2>
      <div className="space-y-2">{all.map(e=><article key={e.channel+e.id} className="rounded-lg border bg-white p-4">
        <div className="flex flex-wrap justify-between gap-2"><span className="font-semibold">{e.channel} · {e.kind}</span><time className="text-sm">{e.created_at}</time></div>
        <p className="text-sm text-slate-600">Cafe {e.business_id}</p>
        <p className="my-2 break-words">{e.description}</p><p className="text-sm">State: {e.sent} · Open: {e.opened} · Action: {e.acted}</p>
      </article>)}{!all.length&&<p>No proactive activity recorded.</p>}</div>
    </section>
  </div>;
}
