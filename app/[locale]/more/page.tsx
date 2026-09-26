import { ChevronRight, CreditCard, FileText, Receipt, TrendingUp } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { DEMO_BUSINESS_ID } from "@/lib/constants";
import { Link } from "@/i18n/navigation";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import BusinessSwitch from "@/components/more/BusinessSwitch";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function MorePage() {
  const user = await requireUser();
  const t = await getTranslations("More");

  let activeBusinessId = DEMO_BUSINESS_ID;
  let ownBusinessId: string | null = null;
  if (isSupabaseConfigured() && user) {
    const supabase = await createServerSupabaseClient();
    activeBusinessId = await getActiveBusinessId(user.id);
    const { data: memberships } = await supabase.from("memberships").select("business_id, businesses(is_demo)").eq("user_id", user.id);
    const own = (memberships ?? []).find((m) => {
      const b = m.businesses as unknown as { is_demo: boolean } | { is_demo: boolean }[] | null;
      const isDemo = Array.isArray(b) ? b[0]?.is_demo : b?.is_demo;
      return isDemo === false;
    });
    ownBusinessId = own?.business_id ?? null;
  }

  const links = [
    { href: "/more/bills", Icon: Receipt, label: t("monthlyBills") },
    { href: "/more/uploads", Icon: FileText, label: t("uploads") },
    { href: "/more/break-even", Icon: TrendingUp, label: t("breakEven") },
    { href: "/onboarding", Icon: CreditCard, label: t("connectRegister") },
  ];

  return (
    <main className="flex flex-col gap-3.5 px-4 py-6">
      <header className="flex items-center justify-between gap-3 px-1">
        <h1 className="font-headline text-3xl font-semibold text-ink">{t("title")}</h1>
        <LanguageSwitch href="/more" />
      </header>

      <BusinessSwitch
        activeBusinessId={activeBusinessId}
        ownBusinessId={ownBusinessId}
        labels={{ title: t("businessSwitchTitle"), demo: t("demoCafe"), mine: t("myCafe"), noOwnBusiness: t("noOwnBusinessYet") }}
      />

      <div className="flex flex-col rounded-card-lg bg-card px-2">
        {links.map(({ href, Icon, label }) => (
          <Link key={href} href={href} className="flex items-center gap-3 border-b border-[#EFE7DB] px-2.5 py-4 text-ink no-underline last:border-b-0">
            <Icon aria-hidden="true" size={20} className="text-ink-muted" />
            <span className="flex-1 text-base font-semibold">{label}</span>
            <ChevronRight aria-hidden="true" size={18} className="text-ink-muted rtl:rotate-180" />
          </Link>
        ))}
      </div>
    </main>
  );
}
