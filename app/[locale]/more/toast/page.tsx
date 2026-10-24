import {getTranslations} from "next-intl/server";
import {notFound} from "next/navigation";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import PageShell from "@/components/shared/PageShell";
import BackHeader from "@/components/shared/BackHeader";
import ToastConnectionForm from "@/components/more/ToastConnectionForm";
import ToastOwnerDashboard from "@/components/more/ToastOwnerDashboard";
import {trustedToastOrigin} from "@/lib/pos/toast/client";
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
  // This list is trusted server configuration, never an owner-supplied outbound URL.
  const allowedHostValue=process.env.TOAST_ALLOWED_API_HOSTS??"";
  const approvedOrigins=[...new Set(allowedHostValue.split(",").map(host=>{
    try{return trustedToastOrigin("https://"+host.trim(),allowedHostValue);}
    catch{return null;}
  }).filter((origin):origin is string=>Boolean(origin)))];
  let defaultApiOrigin="";
  try{
    if(process.env.TOAST_DEFAULT_API_ORIGIN)
      defaultApiOrigin=trustedToastOrigin(process.env.TOAST_DEFAULT_API_ORIGIN,allowedHostValue);
  }catch{defaultApiOrigin="";}
  if(!defaultApiOrigin&&approvedOrigins.length===1)defaultApiOrigin=approvedOrigins[0];
  const setupReady=process.env.TOAST_SETUP_ENABLED==="true"&&approvedOrigins.length>0;
  const t=await getTranslations("ToastConnect");
  const common=await getTranslations("Common");
  return (
    <PageShell className="flex flex-col gap-4 px-4 pb-8 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more"
        backLabel={common("back")}/>
      {!setupReady ? <section className="rounded-card-lg bg-card p-5 text-ink">
        <p className="text-lg font-semibold">{t("notEnabledPlain")}</p>
        <p className="mt-3 text-base">{t("askToEnable")}</p>
      </section> : <>
      <ToastConnectionForm
        businessId={businessId}
        locations={locations??[]}
        approvedOrigins={approvedOrigins}
        defaultApiOrigin={defaultApiOrigin}
        enabled={setupReady}
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
          retryAfter:t("retryAfter"),lastSync:t("lastSync"),
          errorAuthentication:t("errorAuthentication"),errorMissingPermissions:t("errorMissingPermissions"),
          errorUnauthorizedLocation:t("errorUnauthorizedLocation"),errorTimeout:t("errorTimeout"),
          errorRateLimited:t("errorRateLimited"),errorUnavailable:t("errorUnavailable"),
          errorInvalidResponse:t("errorInvalidResponse"),
          needsAttention:t("needsAttention"),fix:t("fix"),technicalDetails:t("technicalDetails"),
          connectedLastSync:t.raw("connectedLastSync"),noSyncYet:t("noSyncYet"),
          manualLocationHint:t("manualLocationHint"),chooseApiUrl:t("chooseApiUrl"),
        }}/>
      <ToastOwnerDashboard businessId={businessId} currency="USD"/>
      </>}
    </PageShell>
  );
}
