export class SourceAccessChanged extends Error {
  constructor() {super("External source access changed");}
}

/** A fetched response is usable only under the same live authorization that
 * started the request. This also applies to reads that cannot be retained. */
export async function readWithSourceAccess<T>(
  authorize: () => Promise<string | number | void>,
  read: () => Promise<T>,
  discard?: (value: T) => Promise<void>,
): Promise<T> {
  const grant=await authorize();
  const value=await read();
  try {
    if(await authorize()!==grant)throw new SourceAccessChanged();
    return value;
  } catch (error) {
    await discard?.(value);
    throw error;
  }
}

/** Providers own their endpoints, authentication and pagination tokens. Never
 * treat a repeated token or an interrupted page as the end of a collection. */
export async function readProviderPages<T>(
  fetchPage: (cursor: string | null) => Promise<{items: T[]; next: string | null; commit?: () => Promise<void>}>,
  initialCursor: string | null = null,
): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set(initialCursor ? [initialCursor] : []);
  let cursor = initialCursor;
  do {
    const {items, next, commit} = await fetchPage(cursor);
    if (!Array.isArray(items) || (next !== null && (typeof next !== "string" || !next || seen.has(next)))) {
      throw new Error("Invalid provider page or repeated continuation token");
    }
    if (next !== null) seen.add(next);
    await commit?.();
    for (const item of items) result.push(item);
    cursor = next;
  } while (cursor !== null);
  return result;
}
