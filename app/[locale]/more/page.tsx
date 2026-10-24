import { AlertTriangle, ChevronRight, CreditCard, FileText, Languages, Menu as MenuIcon, Percent, Receipt, Shield, SlidersHorizontal, Store, Target, Trash2, UserRound, Users, type LucideIcon } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { parseThemeCookie, parseModeCookie } from "@/app/themes";
import { ThemePicker } from "@/components/ui/ThemePicker";
import { requireUser } from "@/lib/auth/requireUser";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import SignOutButton from "@/components/more/SignOutButton";
import { getMoreBadgeInputs } from "@/lib/data/getMoreBadges";
import { buildMoreBadges } from "@/lib/viewmodels/moreBadges";
import { routing } from "@/i18n/routing";

export const dynamic = "force-dynamic";

type FixBadge = { label: string; href: string; warning?: boolean };

function MoreRow({ href, Icon, label, badge, warn = false }: {
  href: string; Icon: LucideIcon; label: string; badge?: FixBadge; warn?: boolean;
}) {
  return <div className="flex min-h-14 items-center gap-2 border-b border-line px-2.5 last:border-b-0">
    <Link href={href} className={`flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2 text-[17px] no-underline ${warn ? "text-warn" : "text-ink"}`}>
      <Icon aria-hidden="true" size={20} className={`shrink-0 ${warn ? "text-warn" : "text-ink-muted"}`} />
      <span className="min-w-0 flex-1 font-semibold">{label}</span>
      {!badge && <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-ink-muted rtl:rotate-180" />}
    </Link>
    {badge && <Link href={badge.href} aria-label={`${label}: ${badge.label}`}
      className={`inline-flex min-h-12 max-w-[48%] shrink-0 items-center gap-1 rounded-full px-3 py-2 text-end text-sm font-semibold no-underline ${badge.warning ? "bg-warn-tint text-warn" : "bg-good-tint text-good"}`}>
      <span>{badge.label}</span><ChevronRight aria-hidden="true" size={14} className="shrink-0 rtl:rotate-180" />
    </Link>}
  </div>;
}

function MoreGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="flex flex-col gap-2" aria-label={title}>
    <h2 className="px-1 font-headline text-xl font-bold text-ink">{title}</h2>
    <div className="rounded-card-lg border border-line bg-card px-2">{children}</div>
  </section>;
}

export default async function MorePage() {
  const user = await requireUser();
  const [cookieStore, t, locale, evidence] = await Promise.all([
    cookies(), getTranslations("More"), getLocale(), getMoreBadgeInputs(user?.id),
  ]);
  const badges = buildMoreBadges(evidence);
  const number = new Intl.NumberFormat(locale);
  const amount = badges.monthlyBillsCents === null ? null :
    new Intl.NumberFormat(locale, { style: "currency", currency: evidence.currency || "USD" })
      .format(badges.monthlyBillsCents / 100);
  const hoursBadge: FixBadge | undefined = badges.hoursNotSet
    ? { label: t("hoursNotSet"), href: "/more/cafe-profile?focus=hours", warning: true } : undefined;
  const toastBadge: FixBadge | undefined = badges.toast
    ? { label: t(badges.toast), href: "/more/toast", warning: badges.toast !== "connected" } : undefined;
  const uploadBadge: FixBadge | undefined = badges.uploadsNeedingReview
    ? { label: t("uploadsNeedReview", { count: number.format(badges.uploadsNeedingReview) }),
      href: badges.firstUploadToReview ? `/more/uploads/${badges.firstUploadToReview}` : "/more/uploads#upload-history",
      warning: true } : undefined;
  const feesBadge: FixBadge | undefined = badges.missingFeeDays
    ? { label: t("feesDaysMissing", { count: number.format(badges.missingFeeDays) }),
      href: "/more/processing-fees", warning: true } : undefined;
  const billsBadge: FixBadge | undefined = badges.rentMissing
    ? { label: t("rentMissing"), href: "/more/bills?category=rent", warning: true }
    : amount !== null ? { label: t("monthlyAmount", { amount }), href: "/more/bills" } : undefined;
  const alertsBadge: FixBadge | undefined = badges.alerts !== null
    ? { label: number.format(badges.alerts), href: "/more/alerts", warning: badges.alerts > 0 } : undefined;
  const languageNames = { en: t("english"), es: t("spanish"), ar: t("arabic") };

  return <PageShell className="flex flex-col gap-5 px-4 py-6">
    <header className="px-1"><h1 className="font-headline text-3xl font-semibold text-ink">{t("title")}</h1></header>
    <MoreGroup title={t("yourCafe")}>
      <MoreRow href="/more/cafe-profile" Icon={Store} label={t("cafeProfile")} badge={hoursBadge} />
      <MoreRow href="/staff" Icon={Users} label={t("staffSchedule")} />
      <MoreRow href="/menu" Icon={MenuIcon} label={t("menu")} />
    </MoreGroup>
    <MoreGroup title={t("yourData")}>
      <MoreRow href="/more/toast" Icon={CreditCard} label={t("toastConnect")} badge={toastBadge} />
      <MoreRow href="/more/uploads" Icon={FileText} label={t("uploads")} badge={uploadBadge} />
      <MoreRow href="/more/processing-fees" Icon={Percent} label={t("processingFees")} badge={feesBadge} />
      <MoreRow href="/more/bills" Icon={Receipt} label={t("monthlyBills")} badge={billsBadge} />
    </MoreGroup>
    <MoreGroup title={t("planGoals")}>
      <MoreRow href="/more/plan" Icon={Target} label={t("viewPlan")} />
    </MoreGroup>
    <MoreGroup title={t("alerts")}>
      <MoreRow href="/more/alerts" Icon={AlertTriangle} label={t("viewAlerts")} badge={alertsBadge} />
    </MoreGroup>
    <MoreGroup title={t("settings")}>
      <details className="border-b border-line px-2.5">
        <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 py-2 text-[17px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
          <Languages aria-hidden="true" size={20} className="shrink-0 text-ink-muted" />
          <span className="min-w-0 flex-1">{t("language")}</span>
          <ChevronRight aria-hidden="true" size={18} className="text-ink-muted rtl:rotate-180" />
        </summary>
        <div className="flex flex-wrap gap-2 pb-3 ps-8">
          {routing.locales.map((language) => <Link key={language} href="/more" locale={language}
            aria-current={locale === language ? "page" : undefined}
            className={`inline-flex min-h-12 items-center rounded-full border px-4 text-[17px] font-semibold no-underline ${locale === language ? "border-accent-text bg-accent-soft text-accent-text" : "border-line text-ink"}`}>
            {languageNames[language]}
          </Link>)}
        </div>
      </details>
      <details className="border-b border-line px-2.5">
        <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 py-2 text-[17px] font-semibold text-ink [&::-webkit-details-marker]:hidden">
          <SlidersHorizontal aria-hidden="true" size={20} className="shrink-0 text-ink-muted" />
          <span className="flex-1">{t("appearance")}</span>
          <ChevronRight aria-hidden="true" size={18} className="text-ink-muted rtl:rotate-180" />
        </summary>
        <div className="pb-3"><ThemePicker initialTheme={parseThemeCookie(cookieStore.get("cp_theme")?.value)}
          initialMode={parseModeCookie(cookieStore.get("cp_mode")?.value)} /></div>
      </details>
      <MoreRow href="/more/access" Icon={CreditCard} label={t("pricingAccess")} />
      <div className="border-b border-line px-2.5 py-3">
        <div className="flex items-center gap-3 text-[17px] font-semibold text-ink">
          <UserRound aria-hidden="true" size={20} className="shrink-0 text-ink-muted" />
          <span>{t("account")}</span>
        </div>
        {user?.email && <p className="mt-1 ps-8 text-[15px] text-ink-muted">
          {t("signedInAs", { email: user.email })}
        </p>}
        {user && <div className="ps-8"><SignOutButton labels={{
          signOut: t("signOut"), signingOut: t("signingOut"), error: t("signOutError"),
        }} /></div>}
      </div>
      <MoreRow href="/privacy" Icon={Shield} label={t("privacy")} />
      <MoreRow href="/more/delete-account" Icon={Trash2} label={t("deleteAccount")} warn />
    </MoreGroup>
  </PageShell>;
}
