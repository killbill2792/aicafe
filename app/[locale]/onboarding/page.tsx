import {getTranslations} from "next-intl/server";
import {requireUser} from "@/lib/auth/requireUser";
import {isLinkedStaffUser} from "@/lib/staffCommunication/identity.server";
import {redirect} from "next/navigation";
import {ensureOwnBusiness} from "@/lib/actions/onboarding";
import RegisterChoice from "@/components/onboarding/RegisterChoice";
import PageShell from "@/components/shared/PageShell";

export const dynamic="force-dynamic";

/** Toast-first onboarding creates one private real café for the authenticated
 * owner, then links that café to Toast. Nothing mounts a shared demo business. */
export default async function OnboardingPage(){
  const user=await requireUser();
  if(user&&await isLinkedStaffUser(user.id))redirect("/crew");
  const [t,toastT]=await Promise.all([getTranslations("Onboarding"),getTranslations("ToastConnect")]);
  const cafe=await ensureOwnBusiness();
  const toastEnabled=process.env.TOAST_SETUP_ENABLED==="true"&&
    Boolean(process.env.TOAST_ALLOWED_API_HOSTS?.trim());
  return <PageShell className="flex flex-col gap-5 px-4 py-6 pb-10">
    <h1 className="text-2xl font-bold text-ink">{t("step1Title")}</h1>
    <p className="text-[15px] text-ink-muted">{t("step1Subtitle")}</p>
    {"error" in cafe?
      <p className="rounded-2xl bg-warn-tint p-4 text-sm text-warn">
        Unable to set up your café. Please try signing in again.
      </p>:
      <RegisterChoice toastEnabled={toastEnabled}
        labels={{useToast:t("useToast"),unavailable:toastT("notEnabledPlain")}}/>}
  </PageShell>;
}
