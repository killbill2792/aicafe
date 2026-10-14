import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { compensationProvenance, type CompensationProvenance } from "@/lib/calc/scheduling/availability";
import {
  foundationCommandSchema, foundationTables, parseFoundationRecord,
  type FoundationKind,
} from "./foundationSchemas";

type Client = Awaited<ReturnType<typeof createServerSupabaseClient>>;
export type FoundationWriteResult =
  | { ok: true; id: string; revision: number }
  | { ok: false; error: "unauthorized" | "disabled" | "invalid_input" | "conflict_or_missing" | "storage_unavailable" };

async function requireSchedulingOwner(): Promise<
  { supabase: Client; businessId: string } | null
> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return null;

  // Use authenticated, cookie-selected membership; never accept a model- or
  // client-supplied business ID. A manager or shared demo member cannot write.
  const businessId = await getActiveBusinessId(user.id);
  const { data, error } = await supabase.from("memberships")
    .select("role, businesses(is_demo)")
    .eq("business_id", businessId)
    .eq("user_id", user.id)
    .eq("role", "owner")
    .maybeSingle();
  if (error || !data) return null;
  const raw = data.businesses as unknown as { is_demo: boolean } | { is_demo: boolean }[] | null;
  const business = Array.isArray(raw) ? raw[0] : raw;
  if (!business || business.is_demo) return null;
  return { supabase, businessId };
}

/**
 * Explicit owner-only typed record operations. One insert/update/delete is
 * atomic, and its AFTER trigger writes an audit event in that same DB
 * transaction. Multiple windows are separate records, not shifts.
 *
 * PR 1A has no Staff UI or Supervisor tool; opt-in flag stays OFF until the
 * additive database migration and auth/RLS checks are reviewed in staging.
 */
export async function executeFoundationCommand(input: unknown): Promise<FoundationWriteResult> {
  if (process.env.SCHEDULING_FOUNDATION_ENABLED !== "true") {
    return { ok: false, error: "disabled" };
  }
  const command = foundationCommandSchema.safeParse(input);
  if (!command.success) return { ok: false, error: "invalid_input" };

  const kind = command.data.kind as FoundationKind;
  let record: Record<string, unknown> | null = null;
  if (command.data.action !== "delete") {
    try {
      record = parseFoundationRecord(kind, command.data.data);
    } catch {
      return { ok: false, error: "invalid_input" };
    }
  }

  const context = await requireSchedulingOwner();
  if (!context) return { ok: false, error: "unauthorized" };
  const { supabase, businessId } = context;
  const table = foundationTables[kind];

  try {
    if (command.data.action === "create") {
      const { data, error } = await supabase.from(table)
        .insert({ ...record, business_id: businessId })
        .select("id,revision").single();
      if (error || !data) return { ok: false, error: "storage_unavailable" };
      return { ok: true, id: data.id as string, revision: data.revision as number };
    }
    const { id, expectedRevision } = command.data;
    // Revision CAS prevents lost edits, including a stale delete racing a
    // separate owner. Database RLS and composite FKs enforce scope again.
    if (command.data.action === "update") {
      const { data, error } = await supabase.from(table)
        .update(record ?? {})
        .eq("business_id", businessId)
        .eq("id", id as string)
        .eq("revision", expectedRevision as number)
        .select("id,revision").maybeSingle();
      if (error) return { ok: false, error: "storage_unavailable" };
      if (!data) return { ok: false, error: "conflict_or_missing" };
      return { ok: true, id: data.id as string, revision: data.revision as number };
    }
    const { data, error } = await supabase.from(table)
      .delete()
      .eq("business_id", businessId)
      .eq("id", id as string)
      .eq("revision", expectedRevision as number)
      .select("id,revision").maybeSingle();
    if (error) return { ok: false, error: "storage_unavailable" };
    if (!data) return { ok: false, error: "conflict_or_missing" };
    return { ok: true, id: data.id as string, revision: data.revision as number };
  } catch {
    // Do not expose SQL diagnostics (potentially containing another tenant's IDs).
    return { ok: false, error: "storage_unavailable" };
  }
}

export type FoundationReadResult =
  | { ok: true; records: Record<FoundationKind, unknown[]>; audit: unknown[] }
  | { ok: false; error: "disabled" | "unauthorized" | "storage_unavailable" };

export async function readSchedulingFoundation(): Promise<FoundationReadResult> {
  if (process.env.SCHEDULING_FOUNDATION_ENABLED !== "true") {
    return { ok: false, error: "disabled" };
  }
  const context = await requireSchedulingOwner();
  if (!context) return { ok: false, error: "unauthorized" };

  const kinds = Object.keys(foundationTables) as FoundationKind[];
  try {
    const results = await Promise.all(kinds.map((kind) =>
      context.supabase.from(foundationTables[kind]).select("*").eq("business_id", context.businessId),
    ));
    const { data: audit, error: auditError } = await context.supabase
      .from("scheduling_foundation_audit_events")
      .select("table_name,record_id,operation,actor_user_id,recorded_at")
      .eq("business_id", context.businessId)
      .order("recorded_at", { ascending: false })
      .limit(200);
    if (auditError || results.some((result) => result.error)) {
      return { ok: false, error: "storage_unavailable" };
    }
    const records = {} as Record<FoundationKind, unknown[]>;
    for (let i = 0; i < kinds.length; i += 1) {
      records[kinds[i]] = results[i].data ?? [];
    }

    // A compensation attestation is not authoritative without a current
    // canonical employee wage snapshot. The employees UPDATE trigger revokes
    // stale zero attestations; this read guard also fails closed if a legacy
    // import/race ever leaves an inconsistent row. Never expose stale
    // eligibility evidence to a later scheduling planner.
    type CompensationRow = {
      employee_id: string;
      cash_cost_state: CompensationProvenance;
      eligibility_reference?: string | null;
      eligibility_verified_by?: string | null;
      eligibility_verified_at?: string | null;
    };
    const compensation = records.compensation as CompensationRow[];
    if (compensation.length > 0) {
      const employeeIds = [...new Set(compensation.map((row) => row.employee_id))];
      const { data: employees, error: wageError } = await context.supabase
        .from("employees")
        .select("id,wage_amount_cents,default_hourly_wage_cents")
        .eq("business_id", context.businessId)
        .in("id", employeeIds);
      if (wageError) return { ok: false, error: "storage_unavailable" };
      const wages = new Map((employees ?? []).map((row) => [row.id, row]));
      records.compensation = compensation.map((row) => {
        const safeState = compensationProvenance(row, wages.get(row.employee_id) ?? null);
        return safeState === row.cash_cost_state ? row : {
          ...row,
          cash_cost_state: safeState,
          eligibility_reference: null,
          eligibility_verified_by: null,
          eligibility_verified_at: null,
        };
      });
    }

    return { ok: true, records, audit: audit ?? [] };
  } catch {
    return { ok: false, error: "storage_unavailable" };
  }
}
