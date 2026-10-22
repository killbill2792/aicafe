"use client";
import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Link, useRouter } from "@/i18n/navigation";
import { createBrowserSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";

export default function PasswordRecoveryForm({ mode }: { mode: "request" | "update" }) {
  const t = useTranslations("PasswordRecovery");
  const locale = useLocale();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    if (!isSupabaseConfigured()) { setError(t("notConfigured")); return; }
    if (mode === "update" && (password.length < 8 || password !== confirm)) {
      setError(password.length < 8 ? t("passwordTooShort") : t("passwordMismatch"));
      return;
    }
    setPending(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const result = mode === "request"
        ? await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/auth/callback?locale=${locale}&flow=recovery` })
        : await supabase.auth.updateUser({ password });
      if (result.error) throw result.error;
      if (mode === "update") {
        const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
        if (signOutError) throw signOutError;
        router.replace("/login");
        router.refresh();
      } else {
        setDone(true);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("error"));
    } finally { setPending(false); }
  }
  const cls = "h-14 rounded-2xl border border-line bg-card px-4 text-base text-ink";
  if (done) return <div role="status" className="rounded-2xl bg-good-tint p-5"><p>{t("emailSent")}</p><Link href="/login" className="font-bold underline">{t("backToSignIn")}</Link></div>;
  return <form onSubmit={submit} className="flex flex-col gap-3">
    {mode === "request" ? <>
      <label htmlFor="recover-email" className="font-semibold">{t("email")}</label>
      <input id="recover-email" className={cls} type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} required />
    </> : <>
      <label htmlFor="new-password" className="font-semibold">{t("newPassword")}</label>
      <input id="new-password" className={cls} type="password" minLength={8} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} required />
      <label htmlFor="confirm-new-password" className="font-semibold">{t("confirmPassword")}</label>
      <input id="confirm-new-password" className={cls} type="password" minLength={8} autoComplete="new-password" value={confirm} onChange={e=>setConfirm(e.target.value)} required />
    </>}
    {error && <p role="alert" className="text-sm text-warn">{error}</p>}
    <button type="submit" disabled={pending} className="h-14 rounded-full bg-accent font-bold text-on-accent disabled:opacity-60">{pending ? t("working") : mode === "request" ? t("sendResetLink") : t("updatePassword")}</button>
    <Link href="/login" className="text-center text-sm font-semibold underline">{t("backToSignIn")}</Link>
  </form>;
}
