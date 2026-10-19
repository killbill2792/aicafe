"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

export default function SignOutButton({ labels }: { labels: { signOut: string; signingOut: string; error: string } }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function handleSignOut() {
    if (pending) return;
    setPending(true);
    setError(false);
    try {
      const { error: signOutError } = await createBrowserSupabaseClient().auth.signOut();
      if (signOutError) throw signOutError;
      router.replace("/login");
      router.refresh();
    } catch {
      setError(true);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col">
      <button type="button" onClick={handleSignOut} disabled={pending} className="flex min-h-14 items-center gap-3 px-2.5 py-4 text-start text-base font-semibold text-ink disabled:opacity-60">
        <LogOut aria-hidden="true" size={20} className="shrink-0 text-ink-muted" />
        <span className="flex-1">{pending ? labels.signingOut : labels.signOut}</span>
      </button>
      {error && <p className="px-3 pb-3 text-sm text-warn" role="alert">{labels.error}</p>}
    </div>
  );
}
