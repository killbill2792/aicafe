import { AlertTriangle, ChevronRight, CreditCard, FileText, FlaskConical, Receipt, Shield, Trash2, TrendingUp, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Link } from "@/i18n/navigation";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import EditBusinessName from "@/components/more/EditBusinessName";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function MorePage() {
  const user = await requireUser();
  const t = await getTranslations("More");

  let ownBusinessId: string | null = null;
  let ownBusinessName: string | null = null;
  if (isSupabaseConfigured() && user) {
    const supabase = await createServerSupabaseClient();
    const { data: memberships } = await supabase.from("memberships").select("business_id, businesses(is_demo, name)").eq("user_id", user.id);
    const own = (memberships ?? []).find((m) => {
      const b = m.businesses as unknown as { is_demo: boolean; name: string } | { is_demo: boolean; name: string }[] | null;
      const isDemo = Array.isArray(b) ? b[0]?.is_demo : b?.is_demo;
      return isDemo === false;
    });
    ownBusinessId = own?.business_id ?? null;
    const ownBiz = own?.businesses as unknown as { is_demo: boolean; name: string } | { is_demo: boolean; name: string }[] | null;
    ownBusinessName = (Array.isArray(ownBiz) ? ownBiz[0]?.name : ownBiz?.name) ?? null;
  }

  const links = [
    { href: "/more/bills", Icon: Receipt, label: t("monthlyBills") },
    { href: "/more/manage-staff", Icon: Users, label: t("manageStaff") },
    { href: "/more/uploads", Icon: FileText, label: t("uploads") },
    { href: "/more/break-even", Icon: TrendingUp, label: t("breakEven") },
    { href: "/more/try-scenario", Icon: FlaskConical, label: t("tryScenario") },
    { href: "/more/alerts", Icon: AlertTriangle, label: t("alerts") },
    { href: "/onboarding", Icon: CreditCard, label: t("connectRegister") },
  ];

  const accountLinks = [
    { href: "/privacy", Icon: Shield, label: t("privacy") },
    { href: "/more/delete-account", Icon: Trash2, label: t("deleteAccount"), warn: true },
  ];

  return (
    <main className="flex flex-col gap-3.5 px-4 py-6">
      <header className="flex items-center justify-between gap-3 px-1">
        <h1 className="font-headline text-3xl font-semibold text-ink">{t("title")}</h1>
        <LanguageSwitch href="/more" />
      </header>

      {ownBusinessId && ownBusinessName && (
        <EditBusinessName
          businessId={ownBusinessId}
          name={ownBusinessName}
          labels={{ cafeNameLabel: t("cafeNameLabel"), save: t("save"), cancel: t("cancel") }}
        />
      )}

      <div className="flex flex-col rounded-card-lg bg-card px-2">
        {links.map(({ href, Icon, label }) => (
          <Link key={href} href={href} className="flex items-center gap-3 border-b border-[#EFE7DB] px-2.5 py-4 text-ink no-underline last:border-b-0">
            <Icon aria-hidden="true" size={20} className="text-ink-muted" />
            <span className="flex-1 text-base font-semibold">{label}</span>
            <ChevronRight aria-hidden="true" size={18} className="text-ink-muted rtl:rotate-180" />
          </Link>
        ))}
      </div>

      <div className="flex flex-col rounded-card-lg bg-card px-2">
        {accountLinks.map(({ href, Icon, label, warn }) => (
          <Link
            key={href}
            href={href}
            className={`flex items-center gap-3 border-b border-[#EFE7DB] px-2.5 py-4 no-underline last:border-b-0 ${warn ? "text-warn" : "text-ink"}`}
          >
            <Icon aria-hidden="true" size={20} className={warn ? "text-warn" : "text-ink-muted"} />
            <span className="flex-1 text-base font-semibold">{label}</span>
            <ChevronRight aria-hidden="true" size={18} className={`rtl:rotate-180 ${warn ? "text-warn" : "text-ink-muted"}`} />
          </Link>
        ))}
      </div>
    </main>
  );
}
