import { getLocale, getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/requireUser";
import { ensureOwnBusiness } from "@/lib/actions/onboarding";
import { isSquareConfigured } from "@/lib/pos/square/oauth";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getRecurringCosts } from "@/lib/data/getRecurringCosts";
import { EXPENSE_CATEGORY_CODES, type ExpenseCategoryCode } from "@/lib/constants";
import { Link } from "@/i18n/navigation";
import OnboardingProgress from "@/components/onboarding/OnboardingProgress";
import RegisterChoice from "@/components/onboarding/RegisterChoice";
import BillsManager from "@/components/bills/BillsManager";
import PayrollTaxForm from "@/components/onboarding/PayrollTaxForm";
import RecoveryOrderStep from "@/components/onboarding/RecoveryOrderStep";

// Personalized, session-dependent — never statically prerendered.
export const dynamic = "force-dynamic";

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ step?: string; error?: string }> }) {
  await requireUser();
  const { step: stepParam, error } = await searchParams;
  const step = Math.min(5, Math.max(1, Number(stepParam) || 1));
  const locale = await getLocale();
  const t = await getTranslations("Onboarding");
  const tCategories = await getTranslations("Categories");
  const tBills = await getTranslations("Bills");

  const businessResult = await ensureOwnBusiness();
  const businessId = "businessId" in businessResult ? businessResult.businessId : null;

  const categoryLabels = Object.fromEntries(EXPENSE_CATEGORY_CODES.map((c) => [c, tCategories(c)])) as Record<ExpenseCategoryCode, string>;

  return (
    <main className="flex flex-col gap-5 px-4 py-6 pb-10">
      <OnboardingProgress step={step} />
      <h1 className="text-2xl font-bold text-ink">{t(`step${step}Title`)}</h1>
      <p className="text-[15px] text-ink-muted">{t(`step${step}Subtitle`)}</p>

      {error && <p className="rounded-2xl bg-warn-tint p-3.5 text-sm text-warn">{errorMessage(t, error)}</p>}

      {step === 1 && (
        <RegisterChoice
          locale={locale}
          squareConfigured={isSquareConfigured()}
          labels={{
            connectSquare: t("connectSquare"),
            squareNotConfigured: t("squareNotConfigured"),
            useToast: t("useToast"),
            useClover: t("useClover"),
            useOther: t("useOther"),
            csvHint: t("csvHint"),
            skip: t("skipForNow"),
          }}
        />
      )}

      {step === 2 && businessId && (
        <>
          <BillsManager
            bills={await getRecurringCosts()}
            categoryLabels={categoryLabels}
            labels={{ amountLabel: tBills("amountLabel"), dueDayLabel: tBills("dueDayLabel"), save: tBills("save"), delete: tBills("delete"), addHint: tBills("addHint"), edit: tBills("edit") }}
          />
          <Link href="/onboarding?step=3" className="flex h-14 items-center justify-center rounded-full bg-ink text-lg font-bold text-paper">
            {t("continue")}
          </Link>
        </>
      )}

      {step === 3 && <PayrollTaxForm initialPercent={await getPayrollTaxPercent()} labels={{ label: t("payrollTaxLabel"), hint: t("payrollTaxHint"), continueLabel: t("continue") }} />}

      {step === 4 && (
        <div className="flex flex-col gap-4 rounded-card-lg bg-card p-5">
          <p className="text-base leading-snug text-ink">{t("step4Body")}</p>
          <Link href="/onboarding?step=5" className="flex h-14 items-center justify-center rounded-full bg-ink text-lg font-bold text-paper">
            {t("continue")}
          </Link>
        </div>
      )}

      {step === 5 && (
        <RecoveryOrderStep order={await getRecoveryOrder()} categoryLabels={categoryLabels} labels={{ finish: t("finish") }} />
      )}
    </main>
  );
}

function errorMessage(t: Awaited<ReturnType<typeof getTranslations<"Onboarding">>>, error: string): string {
  const known = ["square_not_configured", "invalid_state", "connection_failed"];
  return known.includes(error) ? t(`error_${error}` as "error_square_not_configured" | "error_invalid_state" | "error_connection_failed") : t("errorGeneric");
}

async function getPayrollTaxPercent(): Promise<number> {
  if (!isSupabaseConfigured()) return 12;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return 12;
  const result = await ensureOwnBusiness();
  if ("error" in result) return 12;
  const { data } = await supabase.from("businesses").select("payroll_tax_rate").eq("id", result.businessId).single();
  return data ? Number(data.payroll_tax_rate) * 100 : 12;
}

async function getRecoveryOrder(): Promise<ExpenseCategoryCode[]> {
  if (!isSupabaseConfigured()) return [...EXPENSE_CATEGORY_CODES].filter((c) => c !== "ingredients");
  const supabase = await createServerSupabaseClient();
  const result = await ensureOwnBusiness();
  if ("error" in result) return [...EXPENSE_CATEGORY_CODES].filter((c) => c !== "ingredients");
  const { data } = await supabase.from("recovery_order").select("bucket_code").eq("business_id", result.businessId).order("position", { ascending: true });
  return (data ?? []).map((r) => r.bucket_code as ExpenseCategoryCode);
}
