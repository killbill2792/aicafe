/** Stable client retry identity for PR1A record creates.
 * A network timeout must reuse the same request key and original payload.
 * Editing the draft changes its serialized intent and obtains a NEW key.
 * Keep only an ephemeral in-component reference, never credentials or tenant IDs.
 */
export type PendingCreate = { payload: string; key: string } | null;
export function stableCreateRequestKey(
  state: { current: PendingCreate }, payload: unknown,
): string {
  const serialized = JSON.stringify(payload);
  if (state.current?.payload !== serialized) {
    state.current = { payload: serialized, key: crypto.randomUUID() };
  }
  return state.current.key;
}
