import "server-only";

type QueryErrorLike = { message: string; code?: string; details?: string | null; hint?: string | null } | null | undefined;

/** Logs full diagnostic detail server-side (console.error — captured by Sentry/server logs) for a
 * failed Supabase query. Callers must still decide how to fail (throw, or return a safe
 * ActionResult) — this only ever logs, never itself returns or swallows anything. */
export function logQueryError(context: string, error: QueryErrorLike): void {
  console.error(`[menu:${context}]`, error);
}

/** Generic, owner-safe messages for when a Menu query fails — never the raw Postgres/Supabase
 * error text, which can contain column/table/constraint names that shouldn't reach the UI. */
export const MENU_LOAD_FAILURE_MESSAGE = "Something went wrong loading the menu. Please try again.";
export const MENU_SAVE_FAILURE_MESSAGE = "Something went wrong saving this change. Please try again.";
