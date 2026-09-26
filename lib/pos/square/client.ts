import "server-only";
import { squareApiBaseUrl } from "./oauth";

const SQUARE_VERSION = "2025-05-21"; // Timecards (renamed from Shifts) needs this version or later.

/** Idempotent-safe GET/POST wrapper with exponential backoff on 429/5xx (docs/06-integrations.md). */
export async function squareRequest<T>(
  accessToken: string,
  path: string,
  init?: { method?: "GET" | "POST"; body?: unknown },
): Promise<T> {
  const url = `${squareApiBaseUrl()}${path}`;
  let attempt = 0;
  let lastError: unknown;

  while (attempt < 4) {
    const res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "Square-Version": SQUARE_VERSION,
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });

    if (res.ok) return res.json();

    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(`Square API ${res.status} on ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 500));
      attempt += 1;
      continue;
    }

    throw new Error(`Square API error ${res.status} on ${path}: ${await res.text()}`);
  }

  throw lastError instanceof Error ? lastError : new Error(`Square API request to ${path} failed after retries`);
}

export async function squarePaginated<T>(
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
  itemsKey: string,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await squareRequest<{ cursor?: string } & Record<string, T[]>>(accessToken, path, {
      method: "POST",
      body: cursor ? { ...body, cursor } : body,
    });
    items.push(...(page[itemsKey] ?? []));
    cursor = page.cursor;
  } while (cursor);
  return items;
}
