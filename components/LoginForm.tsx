"use client";

import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { createBrowserSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";

export default function LoginForm() {
  const t = useTranslations("Login");
  const locale = useLocale();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error" | "not_configured">("idle");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isSupabaseConfigured()) {
      setStatus("not_configured");
      return;
    }
    setStatus("sending");
    try {
      const supabase = createBrowserSupabaseClient();
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?locale=${locale}`,
        },
      });
      setStatus(error ? "error" : "sent");
    } catch {
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className="rounded-3xl bg-good-tint p-5 text-[17px] leading-snug text-ink">
        {t("checkEmail", { email })}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label htmlFor="email" className="text-[15px] font-semibold text-ink">
        {t("emailLabel")}
      </label>
      <input
        id="email"
        type="email"
        required
        autoComplete="email"
        inputMode="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder={t("emailPlaceholder")}
        className="h-14 rounded-2xl border border-line bg-card px-4 text-[17px] text-ink placeholder:text-ink-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
      />
      <button
        type="submit"
        disabled={status === "sending"}
        className="h-[60px] rounded-full bg-ink text-[18px] font-bold text-paper disabled:opacity-60"
      >
        {status === "sending" ? t("sending") : t("sendLink")}
      </button>
      {status === "error" && <p className="text-[15px] text-warn">{t("error")}</p>}
      {status === "not_configured" && <p className="text-[15px] text-warn">{t("notConfigured")}</p>}
    </form>
  );
}
