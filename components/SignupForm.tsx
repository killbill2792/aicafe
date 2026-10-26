"use client";

import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { createBrowserSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";

export default function SignupForm() {
  const t = useTranslations("SignUp");
  const locale = useLocale();
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [cafeName, setCafeName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;
    setError(null);

    if (!fullName.trim() || !cafeName.trim()) {
      setError(t("requiredFields"));
      return;
    }
    if (password.length < 8) {
      setError(t("passwordTooShort"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("passwordMismatch"));
      return;
    }
    if (!isSupabaseConfigured()) {
      setError(t("notConfigured"));
      return;
    }

    setStatus("submitting");
    try {
      const supabase = createBrowserSupabaseClient();
      const { data, error: signupError } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?locale=${locale}&flow=signup`,
          // Display information only. Authorization still comes from trusted memberships/RLS.
          data: { full_name: fullName.trim(), cafe_name: cafeName.trim() },
        },
      });
      if (signupError) {
        setError(signupError.message);
        setStatus("idle");
        return;
      }
      if (data.session) {
        // Some Supabase projects do not require email confirmation.
        router.replace("/onboarding");
        router.refresh();
      } else {
        setStatus("sent");
      }
    } catch {
      setError(t("error"));
      setStatus("idle");
    }
  }

  if (status === "sent") {
    return (
      <div className="flex flex-col gap-4 rounded-2xl bg-good-tint p-5 text-base text-ink" role="status">
        <p>{t("checkEmail", { email: email.trim() })}</p>
        <Link href="/login" className="font-bold underline">{t("goToSignIn")}</Link>
      </div>
    );
  }

  const inputClass = "h-14 w-full rounded-2xl border border-line bg-card px-4 text-base text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2";
  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label htmlFor="signup-name" className="text-sm font-semibold text-ink">{t("fullName")}</label>
      <input id="signup-name" className={inputClass} autoComplete="name" required maxLength={100} value={fullName} onChange={(event) => setFullName(event.target.value)} />
      <label htmlFor="signup-cafe" className="text-sm font-semibold text-ink">{t("cafeName")}</label>
      <input id="signup-cafe" className={inputClass} autoComplete="organization" required maxLength={80} value={cafeName} onChange={(event) => setCafeName(event.target.value)} />
      <label htmlFor="signup-email" className="text-sm font-semibold text-ink">{t("email")}</label>
      <input id="signup-email" type="email" className={inputClass} autoComplete="email" inputMode="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
      <label htmlFor="signup-password" className="text-sm font-semibold text-ink">{t("password")}</label>
      <input id="signup-password" type="password" className={inputClass} autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} />
      <p className="text-xs text-ink-muted">{t("passwordHint")}</p>
      <label htmlFor="signup-confirm" className="text-sm font-semibold text-ink">{t("confirmPassword")}</label>
      <input id="signup-confirm" type="password" className={inputClass} autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
      {error && <p className="text-sm text-warn" role="alert">{error}</p>}
      <button type="submit" disabled={status === "submitting"} className="mt-2 h-[60px] rounded-full bg-accent text-lg font-bold text-on-accent disabled:opacity-60">
        {status === "submitting" ? t("creating") : t("createAccount")}
      </button>
      <p className="text-center text-sm text-ink-muted">
        {t("alreadyHaveAccount")} <Link href="/login" className="font-bold text-ink underline">{t("signIn")}</Link>
      </p>
    </form>
  );
}
