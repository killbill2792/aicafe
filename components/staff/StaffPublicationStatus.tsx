import {readStaffWeekPublication} from "@/lib/scheduling/staffPublication.server";
/** Owner-visible output of the canonical publication/worker receipt ledger.
 * Never render a delivery claim from a proposal card or composer open alone. */
export default async function StaffPublicationStatus({week}:{week:string}){
 let status:Awaited<ReturnType<typeof readStaffWeekPublication>>;
 try{status=await readStaffWeekPublication(week);}
 catch{return <p role="alert" className="mt-3 text-sm">Schedule publication status could not be verified.</p>;}
 if(!status)return null;
 const observed=status.delivered+status.read;
 const pending=Math.max(0,status.expected-observed);
 return <section aria-label="Supervisor schedule publication status"
  className="mt-4 rounded-2xl border border-line bg-surface p-4">
  <h3 className="text-lg font-semibold">Supervisor · published staff schedule</h3>
  <p className="mt-1 text-sm">Week of {week} · publication verified at {status.publishedAt}</p>
  <div className="mt-2 flex flex-wrap gap-4 text-sm" role="status">
   <span>{status.expected} scheduled staff</span>
   <span>{status.accepted} provider-accepted, awaiting delivery</span>
   <span>{status.delivered} delivered</span>
   <span>{status.read} read</span>
   <span>{status.prepared} awaiting send</span>
   <span>{status.failed} failed</span>
   <span>{status.uncertain} uncertain</span>
  </div>
  {pending>0&&<p className="mt-2 text-sm text-ink-muted">
   Supervisor continues tracking {pending} employee notifications. Delivery is not
   the same as employee acknowledgement or attendance. See Operations for
   blocked recipients and provider setup issues.
  </p>}
  {status.openedManually>0&&<p className="mt-2 text-sm text-ink-muted">
   {status.openedManually} external message composers opened by owner;
   sending and receipt are unverified.
  </p>}
 </section>;
}
