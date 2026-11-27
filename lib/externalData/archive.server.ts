import "server-only";
import type {SupabaseClient} from "@supabase/supabase-js";
import {retainProviderPayload} from "./retainPayload";

export type Source = {businessId: string; provider: string; account: string};
export type SourceRecord = {key: string; payload: unknown; updatedAt?: string | null};

/** A stream identifies one connector's independent query window or location.
 * A concurrent worker cannot move a checkpoint read by another worker. */
export async function openSourceStream(db: SupabaseClient, source: Source, resource: string, stream: string) {
  const {data, error} = await db.from("external_sync_checkpoints").select("revision,cursor_state")
    .eq("business_id", source.businessId).eq("provider", source.provider).eq("source_account", source.account)
    .eq("resource", resource).eq("stream", stream).maybeSingle();
  if (error) throw error;
  let revision = data?.revision ?? 0;
  return {
    cursor: data?.cursor_state as unknown,
    async commit(records: readonly SourceRecord[], next: unknown, complete: boolean) {
      const {data: saved, error: failure} = await db.rpc("external_commit_page", {
        p_business_id: source.businessId, p_provider: source.provider, p_account: source.account,
        p_resource: resource, p_stream: stream, p_revision: revision, p_next: next, p_complete: complete,
        p_records: records.map(r => ({key: r.key, payload: retainProviderPayload(r.payload), updated_at: r.updatedAt})),
      });
      if (failure) throw failure;
      if (typeof saved !== "number" || saved !== revision + 1) throw new Error("External checkpoint was not confirmed");
      revision = saved;
    },
  };
}
