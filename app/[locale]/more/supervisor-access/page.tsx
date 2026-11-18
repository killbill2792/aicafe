import {notFound} from "next/navigation";
import {getTranslations} from "next-intl/server";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import PageShell from "@/components/shared/PageShell";
import BackHeader from "@/components/shared/BackHeader";
import GmailConnectionPanel from "@/components/more/GmailConnectionPanel";
import SupervisorAccessPanel from "@/components/more/SupervisorAccessPanel";
import en from "@/messages/en.json";

export const dynamic="force-dynamic";
export default async function SupervisorAccessPage(){
 if(!await requireOwnBusiness())notFound();
 const common=await getTranslations("Common");
 return <PageShell className="flex flex-col gap-5 px-4 py-6">
  <BackHeader titleAsHeading title={en.SupervisorAccess.title} subtitle={en.SupervisorAccess.subtitle}
   backHref="/more" backLabel={common("back")}/>
  <p className="text-[17px] text-ink-muted">{en.SupervisorAccess.gmailIntro}</p>
  <GmailConnectionPanel/>
  <SupervisorAccessPanel/>
 </PageShell>;
}