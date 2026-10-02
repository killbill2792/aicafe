import { Link } from "@/i18n/navigation";

/** Shown instead of the Receipt/Voice entry flow when `isAiConfigured()` is false — never lets
 * the owner into a flow that would fail with an API-key/`.env.local` error. Capability-gated, not
 * a permanent removal: as soon as an AI provider key is configured, these routes render their
 * normal flow again with no code change needed here. */
export default function AiUnavailableNotice({ title, message, typeItLabel }: { title: string; message: string; typeItLabel: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card-lg bg-card p-8 text-center">
      <p className="text-base font-bold text-ink">{title}</p>
      <p className="text-sm text-ink-muted">{message}</p>
      <Link href="/add-cost/type" className="rounded-full bg-ink px-5 py-2.5 text-sm font-bold text-paper no-underline">
        {typeItLabel}
      </Link>
    </div>
  );
}
