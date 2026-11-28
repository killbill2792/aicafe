"use client";

import { useActionState } from "react";

export type ProfileSaveStatus = "idle" | "saved" | "invalid" | "failed";

export default function WorkforceProfileForm({
  save, name, title, namePlaceholder, titlePlaceholder, copy,
}: {
  save: (previous: ProfileSaveStatus, form: FormData) => Promise<ProfileSaveStatus>;
  name: string;
  title: string;
  namePlaceholder: string;
  titlePlaceholder: string;
  copy: {
    edit: string; name: string; jobTitle: string; defaults: string; save: string; saving: string;
    saved: string; invalid: string; failed: string;
  };
}) {
  const [status, submit, pending] = useActionState<ProfileSaveStatus, FormData>(save, "idle");
  const fieldStyle = "mt-1 min-h-12 w-full rounded-xl border border-line bg-card px-3 text-[17px] text-ink";

  return <details className="mt-3">
    <summary className="flex min-h-12 cursor-pointer items-center font-semibold text-accent-text underline">{copy.edit}</summary>
    <form action={submit} className="grid gap-3" aria-busy={pending}>
      <p className="text-[17px] text-ink-muted">{copy.defaults}</p>
      <label className="text-[17px] font-semibold">
        {copy.name}
        <input className={fieldStyle} name="displayName" defaultValue={name} placeholder={namePlaceholder}
          autoComplete="off" maxLength={80} dir="auto" />
      </label>
      <label className="text-[17px] font-semibold">
        {copy.jobTitle}
        <input className={fieldStyle} name="jobTitle" defaultValue={title} placeholder={titlePlaceholder}
          autoComplete="off" maxLength={120} dir="auto" />
      </label>
      <button disabled={pending} className="min-h-12 justify-self-start rounded-xl bg-accent px-4 font-bold text-on-accent disabled:opacity-60">
        {pending ? copy.saving : copy.save}
      </button>
      <p role="status" className="text-[17px] text-ink" aria-atomic="true">{status !== "idle" && copy[status]}</p>
    </form>
  </details>;
}
