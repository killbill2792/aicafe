import {notFound} from "next/navigation";
import {getTranslations} from "next-intl/server";
import {Link} from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import SupplierEvidenceManager from "@/components/operations/SupplierEvidenceManager";
import {authenticatedConversationContext} from "@/lib/ai/conversations/auth.server";
export const dynamic="force-dynamic";
export default async function SupplierEvidencePage(){
 await authenticatedConversationContext().catch(()=>notFound());
 const t=await getTranslations("SupplierEvidence");
 return <PageShell className="flex flex-col gap-4 px-4 pb-28 pt-6">
  <header>
   <Link href="/operations" className="flex min-h-12 items-center text-[17px] font-bold text-ink underline">{t("back")}</Link>
   <h1 className="font-headline text-3xl font-bold text-ink">{t("title")}</h1>
  </header>
  <SupplierEvidenceManager copy={{
   title:t("title"),description:t("description"),supplier:t("supplier"),
   item:t("item"),price:t("price"),count:t("count"),unit:t("unit"),
   sourceKind:t("sourceKind"),sourceUrl:t("sourceUrl"),date:t("date"),
   save:t("save"),saving:t("saving"),saved:t("saved"),error:t("error"),
   history:t("history"),empty:t("empty"),notVerified:t("notVerified"),
   search:t("search"),searchButton:t("searchButton"),
   searchUnavailable:t("searchUnavailable"),webNotice:t("webNotice"),
   comparison:t("comparison"),
  }}/>
 </PageShell>;
}
