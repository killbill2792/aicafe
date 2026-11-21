import {readOwnerStaffHistory,ownerStaffLoginList} from "@/lib/staffCommunication/channel.server";
import StaffReplyComposer from "./StaffReplyComposer";
import StaffCommunicationHistory from "./StaffCommunicationHistory";
import {requireSchedulingOwner} from "@/lib/scheduling/foundation.server";
/** Owner-only transcript; staff text is evidence, never instruction to Luna. */
export default async function StaffResponseInbox(){
 const owner=await requireSchedulingOwner();
 if(!owner)return null;
 const {data:{user},error}=await owner.supabase.auth.getUser();
 if(error||!user)return null;
 const [history,employees]=await Promise.all([readOwnerStaffHistory(),ownerStaffLoginList()]);
 return <section className="mt-5 space-y-3 rounded-3xl border border-line bg-card p-5">
  <h2 className="text-xl font-semibold text-ink">Employee responses and reports</h2>
  <p className="text-sm text-ink-muted">Every saved employee message and Supervisor request,
   with original wording and timestamps. Employee reports are not automatically approved business changes.</p>
  <StaffReplyComposer key={`${owner.businessId}:${user.id}`} ownerUserId={user.id}
   businessId={owner.businessId} people={employees.filter(e=>e.active&&e.linked)
   .map(e=>({id:e.id,name:e.name}))}/>
  <StaffCommunicationHistory key={history.events[0]?history.events[0].kind+":"+history.events[0].id:"empty"}
   initial={history}/>
 </section>;
}
