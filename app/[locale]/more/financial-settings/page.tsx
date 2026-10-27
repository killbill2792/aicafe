import {getTranslations} from "next-intl/server";
import {createServerSupabaseClient} from "@/lib/supabase/server";
import {getActiveBusinessId} from "@/lib/data/getActiveBusinessId";
import {requireOwnBusiness} from "@/lib/auth/requireUser";
import PageShell from "@/components/shared/PageShell";
import BackHeader from "@/components/shared/BackHeader";
import FinancialSettingsForm from "@/components/more/FinancialSettingsForm";
export const dynamic="force-dynamic";
export default async function FinancialSettingsPage(){
 const user=await requireOwnBusiness();
 if(!user)throw new Error("Sign in required");
 const db=await createServerSupabaseClient();
 const id=await getActiveBusinessId(user.id);
 const {data,error}=await db.from("businesses")
  .select("target_ingredient_cost_rate,owner_monthly_payroll_extras_cents")
  .eq("id",id).single();
 if(error)throw error;
 const [t,common]=await Promise.all([getTranslations("SupervisorFinancialSettings"),getTranslations("Common")]);
 return <PageShell className="flex flex-col gap-5 px-4 pb-8 pt-6">
  <BackHeader title={t("title")} subtitle={t("subtitle")} backHref="/more"
   backLabel={common("back")}/>
  <FinancialSettingsForm
   initialIngredientRate={data.target_ingredient_cost_rate==null?null:Number(data.target_ingredient_cost_rate)}
   initialOwnerPayroll={data.owner_monthly_payroll_extras_cents==null?null:Number(data.owner_monthly_payroll_extras_cents)}
   labels={{ingredient:t("ingredient"),ingredientHint:t("ingredientHint"),
    monthlyPayroll:t("monthlyPayroll"),monthlyPayrollHint:t("monthlyPayrollHint"),
    save:t("save"),saving:t("saving"),saved:t("saved"),failed:t("failed"),none:t("none")}}/>
 </PageShell>;
}
