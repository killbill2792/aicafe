import Link from "next/link";
import {redirect} from "next/navigation";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {currentStaffIdentity,getStaffInbox} from "@/lib/staffCommunication/channel.server";
import CrewInbox from "@/components/crew/CrewInbox";
export const dynamic="force-dynamic";
export default async function CrewPage(){
 const db=await createServerSupabaseClient();
 const {data:{user}}=await db.auth.getUser();
 if(!user)redirect("/crew/login");
 const identity=await currentStaffIdentity();
 if(!identity)return <section className="space-y-3 rounded-3xl border border-line bg-card p-6">
  <h1 className="text-2xl font-bold">Staff access not linked</h1>
  <p>Ask your café owner to connect this existing login to your employee record.</p>
  <Link className="underline" href="/crew/login">Sign in with a different account</Link>
 </section>;
 const data=await getStaffInbox();
 return <CrewInbox {...data} authUserId={user.id}/>;
}
