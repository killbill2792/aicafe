import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {readProviderPages,readWithSourceAccess} from "./pages";
import {retainProviderPayload} from "./retainPayload";

export type Source = {businessId: string; provider: string; account: string};
export type SourceIdentifier = {
  namespace: string; value: string; selector: object;
  relationship?: string; shared?: boolean;
};
export type SourceRecord = {key: string; payload: unknown; updatedAt?: string | null; identifiers?: SourceIdentifier[]};

/** A stream identifies one connector's independent query window or location.
 * A concurrent worker cannot move a checkpoint read by another worker. */
export async function openSourceStream(db: SupabaseClient, source: Source, resource: string, stream: string) {
  const scope = {p_business_id: source.businessId, p_provider: source.provider, p_account: source.account,
    p_resource: resource, p_stream: stream};
  const {data, error} = await db.from("external_sync_checkpoints").select("revision,cursor_state")
    .eq("business_id", source.businessId).eq("provider", source.provider).eq("source_account", source.account)
    .eq("resource", resource).eq("stream", stream).maybeSingle();
  if (error) throw error;
  let revision = data?.revision ?? 0;
  return {
    cursor: data?.cursor_state as unknown,
    async commit(records: readonly SourceRecord[], next: unknown, complete: boolean) {
      const {data: saved, error: failure} = await db.rpc("external_commit_page", {
        ...scope, p_revision: revision, p_next: next, p_complete: complete,
        p_records: records.map(r => ({key: r.key, payload: retainProviderPayload(r.payload), updated_at: r.updatedAt, identifiers: r.identifiers})),
      });
      if (failure) throw failure;
      if (typeof saved !== "number" || saved !== revision + 1) throw new Error("External checkpoint was not confirmed");
      revision = saved;
    },
    async completedRecords(): Promise<unknown[]> {
      const records: unknown[] = [];
      let after: string | null = null;
      for (;;) {
        const {data, error: failure}: {data: unknown; error: unknown} = await db.rpc("external_read_observation", {
          ...scope, p_revision: revision, p_after: after,
        });
        if (failure || !Array.isArray(data)) throw failure ?? new Error("Missing external observation");
        records.push(...data.map(row => row.payload));
        if (data.length < 500) return records;
        after = data[data.length - 1].record_id;
      }
    },
  };
}

export type Availability = "pending" | "permission_required" | "incomplete" | "unavailable" | "unsupported";

export type ResourceCapability = {resource: string; permission?: string; granted?: boolean | null};

type ObservationScope = Readonly<Record<string, string>>;
type CursorState = {cursor: string; scope: ObservationScope};
type SourceSync = {
  capability: ResourceCapability;
  stream: string;
  scope: ObservationScope;
  authorize: () => Promise<void>;
  observe: (cursor: string | null, scope: ObservationScope) => Promise<{records: SourceRecord[]; next: string | null}>;
  failure: (error: unknown) => {status: Availability; retryAt?: string; resetCursor?: boolean};
  readCompleted?: boolean;
};

function pendingObservation(value: unknown): CursorState | null {
  if (typeof value === "string" && value) return {cursor: value, scope: {}};
  if (!value || typeof value !== "object" || !("cursor" in value) || value.cursor === null) return null;
  if (typeof value.cursor !== "string" || !value.cursor || !("scope" in value) ||
    !value.scope || typeof value.scope !== "object" || Array.isArray(value.scope) ||
    Object.values(value.scope).some(part => typeof part !== "string")) {
    throw new Error("Invalid external checkpoint");
  }
  return {cursor: value.cursor, scope: value.scope as ObservationScope};
}

/** Complete a saved observation in its original query scope before moving to
 * the newly requested one. A later page never certifies a different window. */
export async function synchronizeSource(db: SupabaseClient, source: Source, plan: SourceSync): Promise<unknown[]> {
  const {resource} = plan.capability;
  await discoverSourceResources(db, source, [plan.capability], new Date().toISOString());
  const stream = await openSourceStream(db, source, resource, plan.stream);
  const pending = pendingObservation(stream.cursor);
  let cursor = pending?.cursor ?? null;
  const observe = async (scope: ObservationScope) => {
    await readProviderPages(async current => {
      const page = await readWithSourceAccess(plan.authorize,()=>plan.observe(current,scope));
      return {items: [], next: page.next, commit: async () => {
        await stream.commit(page.records, {cursor: page.next, scope}, page.next === null);
        cursor = page.next;
      }};
    }, cursor);
  };
  try {
    if (pending) await observe(pending.scope);
    if (!pending || JSON.stringify(Object.entries(pending.scope).sort()) !==
        JSON.stringify(Object.entries(plan.scope).sort())) await observe(plan.scope);
    if (!plan.readCompleted) return [];
    const results = await stream.completedRecords();
    await plan.authorize();
    return results;
  } catch (error) {
    // A concurrent successful worker owns the new revision and availability.
    if (error && typeof error === "object" && "code" in error && error.code === "40001") throw error;
    const failure = plan.failure(error);
    if (cursor && failure.resetCursor) await stream.commit([], null, false);
    await noteAvailability(db, source, resource, failure.status, new Date().toISOString(), failure.retryAt);
    throw error;
  }
}

export async function discoverSourceResources(db: SupabaseClient, source: Source,
  capabilities: readonly ResourceCapability[], observedAt: string) {
  const resources = [...new Map(capabilities.map(capability => [capability.resource, capability])).values()];
  const {error} = await db.rpc("external_discover_resources", {
    p_business: source.businessId, p_provider: source.provider, p_account: source.account,
    p_observed_at: observedAt, p_resources: resources,
  });
  if (error) throw error;
}

export async function noteAvailability(db: SupabaseClient, source: Source, resource: string,
  status: Availability, attempt: string, retryAt?: string) {
  const {error}=await db.rpc("external_note_availability",{
    p_business_id:source.businessId,p_provider:source.provider,p_account:source.account,
    p_resource:resource,p_status:status,p_attempt:attempt,p_retry:retryAt ?? null,
  });
  if(error)throw error;
}
