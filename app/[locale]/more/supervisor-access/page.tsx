import {notFound} from "next/navigation";
import {getTranslations} from "next-intl/server";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import PageShell from "@/components/shared/PageShell";
import BackHeader from "@/components/shared/BackHeader";
import GmailConnectionPanel from "@/components/more/GmailConnectionPanel";
import SupervisorAccessPanel from "@/components/more/SupervisorAccessPanel";
import en from "@/messages/en.json";
import {readOwnerSupervisorUsage} from "@/lib/ai/conversations/usage.server";

export const dynamic="force-dynamic";
export default async function SupervisorAccessPage({searchParams}:{searchParams:Promise<{thread?:string|string[]}>}){
 if(!await requireOwnBusiness())notFound();
 const [common,usage]=await Promise.all([getTranslations("Common"),readOwnerSupervisorUsage().catch(()=>null)]);
 const usageCopy=en.SupervisorUsage;
 const thread=(await searchParams).thread;
 const returnThread=typeof thread==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thread)?thread:null;
 return <PageShell className="flex flex-col gap-5 px-4 py-6">
  <BackHeader titleAsHeading title={en.SupervisorAccess.title} subtitle={en.SupervisorAccess.subtitle}
   backHref={returnThread?"/?thread="+encodeURIComponent(returnThread):"/more"} backLabel={common("back")}/>
  <p className="text-[17px] text-ink-muted">{en.SupervisorAccess.gmailIntro}</p>
  <section className="rounded-card-lg border border-line bg-card p-5" aria-labelledby="supervisor-usage-heading">
   <h2 id="supervisor-usage-heading" className="font-headline text-xl font-bold">{usageCopy.title}</h2>
   <p className="mt-2 text-[17px] font-semibold">{usageCopy.max}</p>
   <p className="mt-1 text-[15px] text-ink-muted">{usageCopy.help}</p>
   {usage?<><p className="mt-3 text-[15px] text-ink-muted">{usageCopy.month} · {usage.periodStart.slice(0,7)}</p>
    <dl className="mt-3 grid grid-cols-2 gap-3">
     <div><dt>{usageCopy.requests}</dt><dd className="text-xl font-bold tabular-nums">{usage.ownerRequests.toLocaleString("en-US")}</dd></div>
     <div><dt>{usageCopy.proactive}</dt><dd className="text-xl font-bold tabular-nums">{usage.proactiveItems.toLocaleString("en-US")}</dd></div>
    </dl></>:<p role="status" className="mt-3 text-[15px] text-ink-muted">{usageCopy.unavailable}</p>}
  </section>
  <GmailConnectionPanel/>
  <SupervisorAccessPanel/>
 </PageShell>;
}