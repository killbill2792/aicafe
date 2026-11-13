import {notFound} from "next/navigation";
import {getTranslations} from "next-intl/server";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import PageShell from "@/components/shared/PageShell";
import BackHeader from "@/components/shared/BackHeader";
import GmailConnectionPanel from "@/components/more/GmailConnectionPanel";
export const dynamic="force-dynamic";
export default async function GmailSettingsPage(){
  if(!await requireOwnBusiness())notFound();
  const [t,common]=await Promise.all([getTranslations("GmailConnect"),getTranslations("Common")]);
  return <PageShell className="flex flex-col gap-5 px-4 py-6">
    <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={common("back")}/>
    <GmailConnectionPanel/>
  </PageShell>;
}
