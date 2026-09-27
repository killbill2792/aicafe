import { AlertCircle } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function ReconnectBanner() {
  const t = await getTranslations("Reconnect");
  return (
    <div className="flex items-center gap-3 rounded-2xl border-2 border-warn bg-warn-tint p-3.5">
      <AlertCircle aria-hidden="true" size={20} className="shrink-0 text-warn" />
      <span className="flex-1 text-sm font-semibold text-warn">{t("banner")}</span>
      <Link href="/onboarding" className="shrink-0 rounded-full bg-warn px-3.5 py-2 text-sm font-bold text-white">
        {t("action")}
      </Link>
    </div>
  );
}
