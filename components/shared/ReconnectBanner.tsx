import { AlertCircle } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

/** Use the actual POS provider; never send a Square owner to Toast credentials. */
export function reconnectHref(provider: string): "/more/toast" | "/onboarding" {
  return provider === "toast" ? "/more/toast" : "/onboarding";
}

export default async function ReconnectBanner({ provider }: { provider: string }) {
  const t = await getTranslations("Reconnect");
  return (
    <div className="flex items-center gap-3 rounded-2xl border-2 border-warn bg-warn-tint p-3.5">
      <AlertCircle aria-hidden="true" size={20} className="shrink-0 text-warn" />
      <span className="flex-1 text-sm font-semibold text-warn">{t("banner")}</span>
      <Link href={reconnectHref(provider)} className="shrink-0 rounded-full bg-warn-text px-3.5 py-2 text-sm font-bold text-on-warn">
        {t("action")}
      </Link>
    </div>
  );
}
