export type SalesDataStatus = "actual" | "missing";

/**
 * Canonical sales-coverage rule.
 *
 * explicitStatus exists for imports/connectors that can prove a business date was covered even
 * when it had zero orders / $0 sales. Without that proof, a zero row stays missing so a staff-only
 * rollup never masquerades as a real zero-sales day.
 */
export function resolveSalesDataStatus(params: {
  explicitStatus?: SalesDataStatus;
  previousStatus?: SalesDataStatus | null;
  ordersCount: number;
  netSalesCents: number;
  drinksCount: number;
}): SalesDataStatus {
  if (params.explicitStatus) return params.explicitStatus;
  if (params.ordersCount > 0 || params.netSalesCents !== 0 || params.drinksCount > 0) return "actual";
  if (params.previousStatus === "actual") return "actual";
  return "missing";
}
