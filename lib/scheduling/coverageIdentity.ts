/** A coverage requirement's identity is its demand, not the owner who
 * entered it or its confirmation status. Mirrors the PostgreSQL UNIQUE
 * NULLS NOT DISTINCT coverage identity invariant used for stale creates.
 * Input times must already use normalized HH:mm values from foundation reads.
 */
const coverageIdentityFields = [
  "location_id", "day_of_week", "local_date", "effective_from",
  "effective_to", "start_local", "end_local", "overnight",
  "min_headcount", "qualification_code", "min_overlap_minutes", "priority",
  "min_headcount_during_break",
] as const;

export function findEquivalentCoverage<T extends Record<string, unknown>>(
  rows: readonly T[], draft: Record<string, unknown>,
): T | undefined {
  return rows.find(row => coverageIdentityFields.every(field =>
    (row[field] ?? null) === (draft[field] ?? null)));
}
