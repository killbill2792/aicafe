import "server-only";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import type { ExpenseCategoryCode } from "@/lib/constants";

export type RecurringCostRow = {
  id: string;
  categoryCode: ExpenseCategoryCode;
  label: string;
  amountCents: number;
  frequency: "monthly" | "weekly" | "quarterly" | "yearly";
  dueDay: number | null;
  isEstimate: boolean;
};

export async function getRecurringCosts(): Promise<RecurringCostRow[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const businessId = await getActiveBusinessId(user.id);

  const { data } = await supabase
    .from("cv_bills")
    .select("id:data->id,category_code:data->category_code,label:data->label,amount_cents:data->amount_cents,frequency:data->frequency,due_day:data->due_day,is_estimate:data->is_estimate")
    .eq("business_id", businessId)
    .is("data->>active_to", null)
    .order("data->due_day", { ascending: true });

  return (data ?? []).map((r) => ({
    id: r.id,
    categoryCode: r.category_code as ExpenseCategoryCode,
    label: r.label,
    amountCents: r.amount_cents,
    frequency: r.frequency as RecurringCostRow["frequency"],
    dueDay: r.due_day,
    isEstimate: r.is_estimate,
  }));
}
