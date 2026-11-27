import {readProviderPages,type PageSink} from "@/lib/externalData/pages";
import "server-only";
import { squareApiBaseUrl } from "./oauth";

const SQUARE_VERSION = "2025-05-21"; // Timecards (renamed from Shifts) needs this version or later.

export class SquareRequestError extends Error {
  constructor(readonly status: number, readonly retryAt?: string) {
    super(`Square API error ${status}`);
  }
}

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

    const header=res.headers.get("retry-after");
    const retryAt=header===null?NaN:/^\d+$/.test(header)?Date.now()+Number(header)*1000:Date.parse(header);
    const error=new SquareRequestError(res.status,Number.isFinite(retryAt)?new Date(retryAt).toISOString():undefined);
    if (res.status === 429 || res.status >= 500) {
      lastError = error;
      const delay = 2 ** attempt * 500;
      if (retryAt > Date.now()+delay || attempt===3) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
      continue;
    }

    throw error;
  }

  throw lastError instanceof Error ? lastError : new Error(`Square API request to ${path} failed after retries`);
}

export async function squarePaginated<T>(
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
  itemsKey: string,
  onPage?: PageSink<T>,
  method: "GET" | "POST" = "POST",
): Promise<T[]> {
  return readProviderPages(async cursor => {
    const params = cursor ? {...body, cursor} : body;
    const url = method === "GET" ? path + "?" + new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    ) : path;
    const page = await squareRequest<Record<string, unknown>>(accessToken, url,
      method === "GET" ? {method} : {method, body: params});
    if (page.errors || (page[itemsKey] != null && !Array.isArray(page[itemsKey]))) {
      throw new Error("Incomplete Square response");
    }
    return {items: (page[itemsKey] ?? []) as T[], next: (page.cursor ?? null) as string | null};
  }, onPage);
}
