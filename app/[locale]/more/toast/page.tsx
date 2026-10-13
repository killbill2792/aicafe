import {getTranslations} from "next-intl/server";
import {notFound} from "next/navigation";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import PageShell from "@/components/shared/PageShell";
import BackHeader from "@/components/shared/BackHeader";
import ToastConnectionForm from "@/components/more/ToastConnectionForm";
export const dynamic="force-dynamic";
export default async function ToastConnectionPage() {
  const user=await requireOwnBusiness();
  if(!user)notFound();
  const db=await createServerSupabaseClient();
  const businessId=await getActiveBusinessId(user.id);
  const {data:member}=await db.from("memberships").select("role")
    .eq("business_id",businessId).eq("user_id",user.id).maybeSingle();
  const {data:business}=await db.from("businesses").select("is_demo").eq("id",businessId).maybeSingle();
  if(member?.role!=="owner"||!business||business.is_demo)notFound();
  const {data:locations,error}=await db.from("locations")
    .select("id,name").eq("business_id",businessId).order("name");
  if(error)throw error;
  const t=await getTranslations("ToastConnect");
  const common=await getTranslations("Common");
  return (
    <PageShell className="flex flex-col gap-4 px-4 pb-8 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more"
        backLabel={common("back")}/>
      <ToastConnectionForm
        businessId={businessId}
        locations={locations??[]}
        enabled={process.env.TOAST_SETUP_ENABLED==="true"}
        labels={{
          notEnabled:t("notEnabled"),notConnected:t("notConnected"),configured:t("configured"),
          verified:t("verified"),missingPermissions:t("missingPermissions"),
          needsReconnect:t("needsReconnect"),lastSyncFailed:t("lastSyncFailed"),
          stale:t("stale"),url:t("url"),clientId:t("clientId"),clientSecret:t("clientSecret"),
          locations:t("locations"),restaurantGuid:t("restaurantGuid"),
          save:t("save"),test:t("test"),disconnect:t("disconnect"),lastVerified:t("lastVerified"),
          error:t("error"),saved:t("saved"),success:t("success"),
          pending:t("pending"),disconnectConfirm:t("disconnectConfirm"),
          noLocations:t("noLocations"),instructions:t("instructions"),
          retryAfter:t("retryAfter"),
        }}/>
    </PageShell>
  );
}
