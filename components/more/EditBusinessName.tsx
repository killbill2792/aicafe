"use client";

import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { updateBusinessName } from "@/lib/actions/business";

type Labels = {
  cafeNameLabel: string;
  save: string;
  cancel: string;
};

export default function EditBusinessName({ businessId, name, labels }: { businessId: string; name: string; labels: Labels }) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      const result = await updateBusinessName({ businessId, name: trimmed });
      if (result.ok) setIsEditing(false);
      else setError(result.error);
    });
  }

  if (!isEditing) {
    return (
      <button
        type="button"
        onClick={() => {
          setValue(name);
          setIsEditing(true);
        }}
        className="flex items-center gap-2 rounded-card-lg bg-card p-4 text-start"
      >
        <span className="flex-1 text-base font-bold text-ink">{name}</span>
        <Pencil aria-hidden="true" size={16} className="shrink-0 text-ink-muted" />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-card-lg bg-card p-4">
      <span className="text-xs font-semibold text-ink-muted">{labels.cafeNameLabel}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={80}
        autoFocus
        className="h-12 rounded-xl border border-line px-3 text-base"
      />
      {error && <p className="text-sm text-warn">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSave}
          disabled={isPending || !value.trim()}
          className="h-11 flex-1 rounded-full bg-ink text-sm font-bold text-paper disabled:opacity-40"
        >
          {labels.save}
        </button>
        <button
          type="button"
          onClick={() => {
            setIsEditing(false);
            setValue(name);
            setError(null);
          }}
          className="h-11 rounded-full border border-line px-3.5 text-sm font-semibold text-ink-muted"
        >
          {labels.cancel}
        </button>
      </div>
    </div>
  );
}
