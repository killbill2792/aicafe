/** Providers own their endpoints, authentication and pagination tokens. Never
 * treat a repeated token or an interrupted page as the end of a collection. */
export async function readProviderPages<T>(
  fetchPage: (cursor: string | null) => Promise<{items: T[]; next: string | null; commit?: () => Promise<void>}>,
  onPage?: (items: readonly T[], next: string | null) => Promise<void>,
): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const {items, next, commit} = await fetchPage(cursor);
    if (!Array.isArray(items) || (next !== null && (typeof next !== "string" || !next || seen.has(next)))) {
      throw new Error("Invalid provider page or repeated continuation token");
    }
    if (next !== null) seen.add(next);
    await commit?.();
    await onPage?.(items, next);
    for (const item of items) result.push(item);
    cursor = next;
  } while (cursor !== null);
  return result;
}
