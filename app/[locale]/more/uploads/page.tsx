import { ChevronRight, FileSpreadsheet, Receipt, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";
import { Link } from "@/i18n/navigation";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function UploadsPage() {
  await requireUser();
  const t = await getTranslations("Uploads");
  const tCommon = await getTranslations("Common");

  const links = [
    { href: "/more/uploads/sales", Icon: FileSpreadsheet, label: t("salesLink"), hint: t("salesLinkHint") },
    { href: "/more/uploads/labor", Icon: Users, label: t("laborLink"), hint: t("laborLinkHint") },
    { href: "/add-cost/statement", Icon: Receipt, label: t("bankLink"), hint: t("bankLinkHint") },
  ];

  return (
    <main className="flex flex-col gap-5 px-4 py-6">
      <BackHeader title={t("title")} backHref="/more" backLabel={tCommon("back")} />
      <p className="text-[15px] text-ink-muted">{t("intro")}</p>
      <div className="flex flex-col rounded-card-lg bg-card px-2">
        {links.map(({ href, Icon, label, hint }) => (
          <Link key={href} href={href} className="flex items-center gap-3 border-b border-[#EFE7DB] px-2.5 py-4 text-ink no-underline last:border-b-0">
            <Icon aria-hidden="true" size={20} className="shrink-0 text-ink-muted" />
            <span className="flex flex-1 flex-col">
              <span className="text-base font-semibold">{label}</span>
              <span className="text-sm text-ink-muted">{hint}</span>
            </span>
            <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-ink-muted rtl:rotate-180" />
          </Link>
        ))}
      </div>
    </main>
  );
}
