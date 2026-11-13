import {notFound} from "next/navigation";
import {getTranslations,getLocale} from "next-intl/server";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import PageShell from "@/components/shared/PageShell";
import BackHeader from "@/components/shared/BackHeader";
import GmailConnectionPanel from "@/components/more/GmailConnectionPanel";
export const dynamic="force-dynamic";
export default async function GmailSettingsPage(){
  if(!await requireOwnBusiness())notFound();
  const [locale,common]=await Promise.all([getLocale(),getTranslations("Common")]);
  const headings=locale==="es"?{title:"Gmail",subtitle:"Conecta tu correo de forma segura con Supervisor"}:
    locale==="ar"?{title:"Gmail",subtitle:"اربط بريدك الإلكتروني بأمان مع المشرف"}:
    {title:"Gmail",subtitle:"Connect your email securely to Supervisor"};
  return <PageShell className="flex flex-col gap-5 px-4 py-6">
    <BackHeader title={headings.title} subtitle={headings.subtitle} backHref="/more" backLabel={common("back")}/>
    <GmailConnectionPanel/>
  </PageShell>;
}
