"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

/** docs/02-design-system.md: "Errors say what happened and what to do." */
export default function LocaleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("Errors");

  useEffect(() => {
    console.error("[app error]", error);
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-warn-tint text-warn">
        <AlertTriangle aria-hidden="true" size={26} />
      </span>
      <h1 className="text-xl font-bold text-ink">{t("title")}</h1>
      <p className="max-w-xs text-base text-ink-muted">{t("body")}</p>
      <div className="mt-2 flex flex-col gap-2.5">
        <button type="button" onClick={reset} className="h-14 rounded-full bg-ink px-8 text-base font-bold text-paper">
          {t("tryAgain")}
        </button>
        <Link href="/" className="h-11 text-sm font-semibold text-ink-muted">
          {t("goHome")}
        </Link>
      </div>
    </main>
  );
}
