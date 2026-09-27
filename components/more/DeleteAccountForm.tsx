"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/i18n/navigation";
import { deleteAccount } from "@/lib/actions/deleteAccount";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

export default function DeleteAccountForm({
  labels,
}: {
  labels: { confirmPrompt: string; confirmPlaceholder: string; confirmWord: string; delete: string; deleting: string; error: string };
}) {
  const router = useRouter();
  const [confirmText, setConfirmText] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const canDelete = confirmText.trim().toLowerCase() === labels.confirmWord.toLowerCase();

  function handleDelete() {
    if (!canDelete) return;
    setError(null);
    startTransition(async () => {
      const result = await deleteAccount();
      if (result.ok) {
        const supabase = createBrowserSupabaseClient();
        await supabase.auth.signOut();
        router.push("/login");
      } else {
        setError(result.error ?? labels.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm font-semibold text-ink-muted">
        {labels.confirmPrompt}
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={labels.confirmPlaceholder}
          className="h-12 rounded-xl border border-line px-3 text-base text-ink"
        />
      </label>
      {error && <p className="text-sm text-warn">{error}</p>}
      <button
        type="button"
        onClick={handleDelete}
        disabled={!canDelete || isPending}
        className="h-14 rounded-full bg-warn text-lg font-bold text-white disabled:opacity-40"
      >
        {isPending ? labels.deleting : labels.delete}
      </button>
    </div>
  );
}
