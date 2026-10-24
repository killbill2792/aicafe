export type GeneratedAlertState = { id: string; dedupeKey: string; status: "new" | "seen" | "resolved" | "dismissed" };

/** Only open generated rows can be auto-resolved. Owner-dismissed/resolved history is immutable. */
export function staleGeneratedAlertIds(existing: GeneratedAlertState[], validDedupeKeys: Set<string>): string[] {
  return existing
    .filter((alert) => (alert.status === "new" || alert.status === "seen") && !validDedupeKeys.has(alert.dedupeKey))
    .map((alert) => alert.id);
}

/** A system-cleared alert must be eligible again if its condition returns.
 * Only an explicit owner resolution or dismissal suppresses that occurrence.
 * Historic auto-resolved rows lack the owner marker and are deliberately retryable.
 */
export function blocksGeneratedAlert(
  status: GeneratedAlertState["status"],
  payload: Record<string, unknown> | null,
): boolean {
  if (status === "new" || status === "seen" || status === "dismissed") return true;
  return status === "resolved" && payload?.dispositionSource === "owner";
}

/** Preserve incident fields (dedupe key, employee, month, etc.) when the owner acts. */
export function withOwnerDisposition(
  payload: unknown,
): Record<string, unknown> {
  const source = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown> : {};
  return { ...source, dispositionSource: "owner" };
}
