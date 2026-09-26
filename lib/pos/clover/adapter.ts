import "server-only";
import type { PosAdapter } from "../types";
import { PosNotConnectedError } from "../types";

/**
 * Clover isn't in docs/06-integrations.md at all — added per this session's explicit instruction
 * not to build for Square only. Clover has a public OAuth + REST API (Inventory, Orders,
 * Employees, Payments) similar in shape to Square's, but no sandbox app or credentials exist yet
 * (see PROGRESS.md "Needs connecting"). This adapter shape is ready; every method throws until a
 * Clover developer account and app are set up and this file's fetch calls are written against
 * Clover's actual endpoints. The CSV path (M6, "Other register") works for Clover today.
 */
export function createCloverAdapter(): PosAdapter {
  const fail = () => {
    throw new PosNotConnectedError("clover");
  };
  return {
    provider: "clover",
    fetchOrders: fail,
    fetchCatalogItems: fail,
    fetchEmployees: fail,
    fetchTimecards: fail,
  };
}
