import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import { getCafeProfile } from "@/lib/data/getCafeProfile";
import BackHeader from "@/components/shared/BackHeader";
import CafeProfileForm from "@/components/more/CafeProfileForm";
import PageShell from "@/components/shared/PageShell";

export const dynamic = "force-dynamic";

export default async function CafeProfilePage() {
  const user = await requireOwnBusiness();
  const [profile, t, tCommon] = await Promise.all([
    getCafeProfile(),
    getTranslations("CafeProfile"),
    getTranslations("Common"),
  ]);

  return (
    <PageShell className="flex flex-col gap-4 px-4 pb-8 pt-6">
      <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more" backLabel={tCommon("back")} />
      {user?.email && (
        <p className="px-1 text-sm text-ink-muted">{t("signedInAs", { email: user.email })}</p>
      )}
      <CafeProfileForm
        profile={profile}
        labels={{
          businessDetails: t("businessDetails"),
          cafeName: t("cafeName"),
          locationName: t("locationName"),
          openedOn: t("openedOn"),
          timezone: t("timezone"),
          timezoneHint: t("timezoneHint"),
          currency: t("currency"),
          address: t("address"),
          addressLine1: t("addressLine1"),
          addressLine2: t("addressLine2"),
          city: t("city"),
          region: t("region"),
          postalCode: t("postalCode"),
          countryCode: t("countryCode"),
          regularHours: t("regularHours"),
          regularHoursHint: t("regularHoursHint"),
          dayMon: t("dayMon"),
          dayTue: t("dayTue"),
          dayWed: t("dayWed"),
          dayThu: t("dayThu"),
          dayFri: t("dayFri"),
          daySat: t("daySat"),
          daySun: t("daySun"),
          notSet: t("notSet"),
          open: t("open"),
          closed: t("closed"),
          opens: t("opens"),
          closes: t("closes"),
          save: t("save"),
          saving: t("saving"),
          saved: t("saved"),
        }}
      />
    </PageShell>
  );
}
