import {notFound} from "next/navigation";
import {getTranslations} from "next-intl/server";
import en from "@/messages/en.json";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import PageShell from "@/components/shared/PageShell";
import BackHeader from "@/components/shared/BackHeader";
import GmailConnectionPanel from "@/components/more/GmailConnectionPanel";
export const dynamic="force-dynamic";
export default async function GmailSettingsPage(){
  if(!await requireOwnBusiness())notFound();
  const common=await getTranslations("Common");
  const headings=en.GmailConnect;
  return <PageShell className="flex flex-col gap-5 px-4 py-6">
    <BackHeader title={headings.title} subtitle={headings.subtitle} backHref="/more" backLabel={common("back")}/>
    <GmailConnectionPanel/>
  </PageShell>;
}
