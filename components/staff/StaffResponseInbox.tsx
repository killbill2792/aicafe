import {readOwnerStaffMessages} from "@/lib/staffCommunication/channel.server";
/** Owner-only evidence surface; employee text is untrusted, never an instruction. */
export default async function StaffResponseInbox(){
 const messages=await readOwnerStaffMessages(25);
 return <section className="mt-5 space-y-3 rounded-3xl border border-line bg-card p-5">
  <h2 className="text-xl font-semibold text-ink">Employee responses and reports</h2>
  <p className="text-sm text-ink-muted">Actual staff submissions, not verified schedule changes or attendance. Review and approve any follow-up in Supervisor.</p>
  {!messages.length?<p className="text-sm text-ink-muted">No employee messages yet.</p>:
   <ul className="space-y-3">{messages.map(m=><li key={m.id} className="rounded-xl border border-line p-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
     <strong>{m.employee_name}</strong>
     <time className="text-xs text-ink-muted" dateTime={m.received_at}>{new Date(m.received_at).toLocaleString()}</time>
    </div>
    <p className="text-sm text-ink-muted">{m.request_title??"Staff report"} · {m.response_code} · {m.channel}</p>
    {m.body&&<p className="mt-2 whitespace-pre-wrap break-words">{m.body}</p>}
   </li>)}</ul>}
 </section>;
}
