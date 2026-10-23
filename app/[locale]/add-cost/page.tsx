import { Camera, FileText, Mic, Keyboard } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { requireOwnBusiness } from "@/lib/auth/requireUser";
import BackHeader from "@/components/shared/BackHeader";
import { Link } from "@/i18n/navigation";
import PageShell from "@/components/shared/PageShell";
import { isAiConfigured } from "@/lib/ai/types";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function AddCostPage({ searchParams }: { searchParams: Promise<{ category?: string; returnTo?: string }> }) {
  await requireOwnBusiness();
  const { category, returnTo } = await searchParams;
  const params = new URLSearchParams();
  if (EXPENSE_CATEGORY_CODES.includes(category as ExpenseCategoryCode)) params.set("category", category!);
  if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//") && !/[%\\\u0000-\u001f\u007f]/.test(returnTo)) params.set("returnTo", returnTo);
  const suffix = params.size ? `?${params.toString()}` : "";
  const aiEnabled = isAiConfigured();
  const t = await getTranslations("AddCost");
  const tCommon = await getTranslations("Common");

  const options = [
    ...(aiEnabled ? [{ href: "/add-cost/receipt", Icon: Camera, label: t("optionPhoto"), hint: t("optionPhotoHint") },
    ] : []),
    { href: "/add-cost/statement", Icon: FileText, label: t("optionStatement"), hint: t("optionStatementHint") },
    ...(aiEnabled ? [{ href: "/add-cost/voice", Icon: Mic, label: t("optionVoice"), hint: t("optionVoiceHint") },
    ] : []),
    { href: "/add-cost/type", Icon: Keyboard, label: t("optionType"), hint: t("optionTypeHint") },
  ];

  return (
    <PageShell className="flex flex-col gap-5 px-4 py-6">
      <BackHeader title={t("title")} backLabel={tCommon("back")} />
      <div className="grid grid-cols-2 gap-3">
        {options.map(({ href, Icon, label, hint }) => (
          <Link
            key={href}
            href={`${href}${suffix}`}
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
    </PageShell>
  );
}
