import {requireAdmin} from "@/lib/admin/auth.server";
import {createAdminSupabaseClient} from "@/lib/supabase/admin";
import {readRecentBriefRuns,briefRunsSince} from "@/lib/operating/briefRuns.server";
import {briefSettings} from "@/lib/operating/briefTest.server";
import {whatsappBriefSendReady} from "@/lib/whatsapp/morningBriefDelivery.server";
import TestBriefButton from "@/components/admin/TestBriefButton";
export const dynamic="force-dynamic";
const TEST_CAFE_ID="719af528-af8e-4203-bb25-4c118c9ff832";
/** Admin only: why each café's morning brief did or did not go out. */
export default async function AdminBriefs(){
  await requireAdmin();
  const db=createAdminSupabaseClient();
  const since=briefRunsSince(3);
  const [cafes,runs,outbox,ready]=await Promise.all([
    db.from("businesses").select("id,name,is_demo").order("name").limit(500),
    readRecentBriefRuns(db,since),
    db.from("whatsapp_outbox").select("business_id,owner_user_id,business_date,state,failure_code,created_at")
      .eq("kind","daily_brief").gte("business_date",since).order("created_at",{ascending:false}).limit(200),
    whatsappBriefSendReady(db),
  ]);
  const names=new Map((cafes.data??[]).map(c=>[String(c.id),String(c.name)]));
  const real=(cafes.data??[]).filter(c=>!c.is_demo).map(c=>({id:String(c.id),name:String(c.name)}));
  const settings=briefSettings();
  return <div className="space-y-6"><header><h1 className="text-2xl font-bold">Morning briefs</h1>
    <p className="text-sm text-slate-600">Each café&apos;s brief goes out after yesterday&apos;s POS data is in, and no later than
      30 minutes before it opens (06:00 café time when hours are unknown). Every skip is listed with its step and reason.</p></header>
    <section className="rounded-xl border bg-white p-5 text-sm"><h2 className="font-semibold">Settings</h2>
      <ul className="list-disc pl-5">{settings.map(s=><li key={s.name}>{s.name}: {s.on?"on":"OFF"}</li>)}
        <li>Migration 20261104000148_morning_brief_send_window.sql: {ready?"applied":"NOT applied"}</li></ul></section>
    <TestBriefButton cafes={real} defaultCafeId={real.some(c=>c.id===TEST_CAFE_ID)?TEST_CAFE_ID:null}/>
    <section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">Last 3 days</h2>
      {!runs.available&&<p className="text-sm text-red-700">The brief record table is missing: apply migration 148. Skips are in the server log (morning_brief_run) until then.</p>}
      {runs.available&&!runs.rows.length&&<p className="text-sm">No brief activity recorded yet.</p>}
      {runs.rows.length>0&&<div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr><th className="p-1">Day</th><th className="p-1">Café</th><th className="p-1">Who</th><th className="p-1">Channel</th>
          <th className="p-1">Run</th><th className="p-1">Outcome</th><th className="p-1">Step</th><th className="p-1">Reason</th><th className="p-1">Updated</th></tr></thead>
        <tbody>{runs.rows.map(r=><tr key={[r.businessId,r.localDate,r.ownerKey,r.channel,r.runKind].join(":")} className="border-t align-top">
          <td className="p-1">{r.localDate}</td><td className="p-1">{names.get(r.businessId)??r.businessId}</td>
          <td className="p-1">{r.ownerKey==="cafe"?"café":"owner "+r.ownerKey.slice(0,8)}</td><td className="p-1">{r.channel}</td>
          <td className="p-1">{r.runKind}</td><td className="p-1 font-semibold">{r.outcome}</td><td className="p-1">{r.step}</td>
          <td className="p-1 break-words">{r.reason}</td><td className="p-1">{r.updatedAt.slice(11,16)} UTC</td></tr>)}</tbody>
      </table></div>}</section>
    <section className="rounded-xl border bg-white p-5"><h2 className="font-semibold">WhatsApp outbox</h2>
      {outbox.error&&<p className="text-sm text-red-700">Outbox unavailable.</p>}
      {!outbox.error&&!(outbox.data??[]).length&&<p className="text-sm">No WhatsApp briefs queued in the last 3 days.</p>}
      <ul className="text-sm">{(outbox.data??[]).map(o=><li key={o.business_id+o.owner_user_id+o.business_date}>
        {o.business_date} · {names.get(String(o.business_id))??o.business_id} · {o.state}{o.failure_code?" ("+o.failure_code+")":""}</li>)}</ul></section>
  </div>;
}
