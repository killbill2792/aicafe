import { Camera, FileText, Mic, Keyboard } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";
import { Link } from "@/i18n/navigation";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function AddCostPage() {
  await requireUser();
  const t = await getTranslations("AddCost");
  const tCommon = await getTranslations("Common");

  const options = [
    { href: "/add-cost/receipt", Icon: Camera, label: t("optionPhoto"), hint: t("optionPhotoHint") },
    { href: "/add-cost/statement", Icon: FileText, label: t("optionStatement"), hint: t("optionStatementHint") },
    { href: "/add-cost/voice", Icon: Mic, label: t("optionVoice"), hint: t("optionVoiceHint") },
    { href: "/add-cost/type", Icon: Keyboard, label: t("optionType"), hint: t("optionTypeHint") },
  ];

  return (
    <main className="flex flex-col gap-5 px-4 py-6">
      <BackHeader title={t("title")} backLabel={tCommon("back")} />
      <div className="grid grid-cols-2 gap-3">
        {options.map(({ href, Icon, label, hint }) => (
          <Link
            key={href}
            href={href}
            className="flex flex-col items-start gap-3 rounded-card-lg bg-card p-5 text-ink no-underline"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-good-tint text-good">
              <Icon aria-hidden="true" size={24} />
            </span>
            <span className="text-base font-bold">{label}</span>
            <span className="text-sm text-ink-muted">{hint}</span>
          </Link>
        ))}
      </div>
    </main>
  );
}
