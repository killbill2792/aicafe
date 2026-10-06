import { AlertTriangle, ChevronRight, CreditCard, FileText, FlaskConical, Percent, Receipt, Shield, Store, Target, Trash2, TrendingUp, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import { Link } from "@/i18n/navigation";
import LanguageSwitch from "@/components/shared/LanguageSwitch";
import PageShell from "@/components/shared/PageShell";

export const dynamic = "force-dynamic";

export default async function MorePage() {
  await requireUser();
  const t = await getTranslations("More");

  const links = [
    { href: "/more/cafe-profile", Icon: Store, label: t("cafeProfile") },
    { href: "/more/processing-fees", Icon: Percent, label: t("processingFees") },
    { href: "/more/economics", Icon: Target, label: t("economics") },
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
    <PageShell className="flex flex-col gap-3.5 px-4 py-6">
      <header className="flex items-center justify-between gap-3 px-1">
        <h1 className="font-headline text-3xl font-semibold text-ink">{t("title")}</h1>
        <LanguageSwitch href="/more" />
      </header>

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
    </PageShell>
  );
}
