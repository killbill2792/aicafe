import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import {
  compensationProvenance, normalizeSchedulingWallTime, type CompensationProvenance,
} from "@/lib/calc/scheduling/availability";
import {
  foundationCommandSchema, foundationTables, parseFoundationRecord,
  type FoundationKind,
} from "./foundationSchemas";

type Client = Awaited<ReturnType<typeof createServerSupabaseClient>>;
export type FoundationWriteResult =
  | { ok: true; id: string; revision: number }
  | { ok: false; error: "unauthorized" | "disabled" | "invalid_input" | "conflict_or_missing" | "storage_unavailable" };

export async function requireSchedulingOwner(): Promise<
  { supabase: Client; businessId: string } | null
> {
  if (!isSupabaseConfigured()) return null;
  const supabase = await createServerSupabaseClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) return null;

  // Use authenticated, cookie-selected membership; never accept a model- or
  // client-supplied business ID. A manager or shared demo member cannot write.
  const businessId = await getActiveBusinessId(user.id);
  // Shared demo access grants all signups owner membership. Never trust its
  // mutable is_demo flag alone; the fixed demo tenant is not schedulable.
  if (businessId === "11111111-1111-1111-1111-111111111111") return null;
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
      // The database owns the atomic durable request receipt and insert.
      // Plain INSERT would duplicate records/audit on retries or timeouts.
      const { data, error } = await supabase.rpc("scheduling_create_foundation", {
        p_business_id: businessId,
        p_kind: kind,
        p_request_key: command.data.requestKey,
        p_record: record,
      });
      if (error || !data) return { ok: false, error: "storage_unavailable" };
      const result = data as { id?: unknown; revision?: unknown; conflict?: boolean };
      if (result.conflict === true) return { ok: false, error: "conflict_or_missing" };
      if (typeof result.id !== "string" || !Number.isSafeInteger(result.revision) ||
          (result.revision as number) < 1) {
        return { ok: false, error: "storage_unavailable" };
      }
      return { ok: true, id: result.id, revision: result.revision as number };
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

const READ_PAGE_SIZE = 500;
// Never silently return a partial business dataset. If this explicit safety
// budget is exceeded, fail the WHOLE read rather than treating omitted
// availability, qualifications or constraints as nonexistent.
const MAX_ROWS_PER_TABLE = 100_000;

/** UUID keyset paging avoids offset shifts when prior rows are removed. Every
 * page has stable primary-key ordering and is independently tenant filtered.
 * A multi-request read is not a transactional snapshot; later planner phases
 * must still bind versions/snapshots when publishing.
 */
async function readAllTenantRows(
  supabase: Client, table: string, businessId: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let lastId: string | null = null;
  for (;;) {
    const page = supabase.from(table).select("*", { count: "exact" })
      .eq("business_id", businessId)
      .order("id", { ascending: true })
      .limit(READ_PAGE_SIZE);
    const response: {
      data: Record<string, unknown>[] | null;
      error: { message: string } | null;
      count: number | null;
    } = await (lastId ? page.gt("id", lastId) : page);
    const { data, error, count } = response;
    if (error || !data || count === null || data.length > READ_PAGE_SIZE ||
        (data.length < READ_PAGE_SIZE && count > data.length)) {
      // A smaller PostgREST max-rows setting must not look like a last page.
      throw new Error("incomplete foundation read");
    }
    for (const row of data) {
      if (typeof row.id !== "string" || (lastId !== null && row.id <= lastId)) {
        throw new Error("unstable scheduling pagination");
      }
      lastId = row.id;
      rows.push(row);
      if (rows.length > MAX_ROWS_PER_TABLE) throw new Error("foundation read capacity exceeded");
    }
    if (data.length < READ_PAGE_SIZE) return rows;
  }
}

const timedKinds: FoundationKind[] = [
  "availability_rule", "availability_exception", "preference_window", "coverage",
];
function normalizeReadTimes(kind: FoundationKind, rows: Record<string, unknown>[]) {
  if (!timedKinds.includes(kind)) return rows;
  return rows.map((row) => ({
    ...row,
    start_local: typeof row.start_local === "string"
      ? normalizeSchedulingWallTime(row.start_local) : row.start_local,
    end_local: typeof row.end_local === "string"
      ? normalizeSchedulingWallTime(row.end_local) : row.end_local,
  }));
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
      readAllTenantRows(context.supabase, foundationTables[kind], context.businessId),
    ));
    // Audits are also complete; a 200-row latest-only limit must not silently
    // imply it is the entire revision history. Stable id keyset paging first.
    const audit = await readAllTenantRows(
      context.supabase, "scheduling_foundation_audit_events", context.businessId,
    );
    audit.sort((a, b) =>
      String(b.recorded_at).localeCompare(String(a.recorded_at)) ||
      String(b.id).localeCompare(String(a.id)),
    );
    const records = {} as Record<FoundationKind, unknown[]>;
    for (let i = 0; i < kinds.length; i += 1) {
      records[kinds[i]] = normalizeReadTimes(kinds[i], results[i]);
    }

    // Every compensation label must agree with the current canonical wage
    // record. Database triggers revoke stale states during wage edits; read
    // validation fails closed if stale data nevertheless exist after a race,
    // legacy import or other unexpected writer.
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
      // Bound each IN query by 100 unique employee IDs, safely below the
      // PostgREST page limit; absent wage rows remain UNKNOWN.
      const wages = new Map<string, {
        wage_period: string | null;
        wage_amount_cents: number | null;
        default_hourly_wage_cents: number | null;
      }>();
      for (let i = 0; i < employeeIds.length; i += 100) {
        const chunk = employeeIds.slice(i, i + 100);
        const { data: employees, error: wageError } = await context.supabase
          .from("employees")
          .select("id,wage_period,wage_amount_cents,default_hourly_wage_cents")
          .eq("business_id", context.businessId)
          .in("id", chunk);
        if (wageError || !employees || employees.length > chunk.length) {
          return { ok: false, error: "storage_unavailable" };
        }
        for (const employee of employees) {
          if (!chunk.includes(employee.id) || wages.has(employee.id)) {
            return { ok: false, error: "storage_unavailable" };
          }
          wages.set(employee.id, employee);
        }
      }
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

    return { ok: true, records, audit };
  } catch {
    return { ok: false, error: "storage_unavailable" };
  }
}
