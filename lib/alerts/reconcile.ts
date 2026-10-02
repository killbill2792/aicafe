export type GeneratedAlertState = { id: string; dedupeKey: string; status: "new" | "seen" | "resolved" | "dismissed" };

/** Only open generated rows can be auto-resolved. Owner-dismissed/resolved history is immutable. */
export function staleGeneratedAlertIds(existing: GeneratedAlertState[], validDedupeKeys: Set<string>): string[] {
  return existing
    .filter((alert) => (alert.status === "new" || alert.status === "seen") && !validDedupeKeys.has(alert.dedupeKey))
    .map((alert) => alert.id);
}
