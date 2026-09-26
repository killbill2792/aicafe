import "server-only";
import type { PosAdapter } from "../types";
import { PosNotConnectedError } from "../types";

/**
 * Toast API access needs partner approval or the restaurant's own read-only API credentials on a
 * qualifying plan (docs/06-integrations.md) — not available in v1. This adapter shape exists so
 * the rest of the app (sync jobs, screens) is ready the moment credentials exist; every method
 * throws until then. The working path for Toast today is the CSV importer (M6), which writes the
 * same `orders`/`order_lines`/`timecards` tables directly with `provider = 'csv'` — it doesn't
 * need this adapter at all.
 */
export function createToastAdapter(): PosAdapter {
  const fail = () => {
    throw new PosNotConnectedError("toast");
  };
  return {
    provider: "toast",
    fetchOrders: fail,
    fetchCatalogItems: fail,
    fetchEmployees: fail,
    fetchTimecards: fail,
  };
}
