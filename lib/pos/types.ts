/**
 * One adapter interface for every register (docs/06-integrations.md + this session's explicit
 * "don't build for Square only"). The rest of the app (sync jobs, rollups, screens) only ever
 * talks to this shape — it never knows whether the data came from Square, a Toast CSV, or the
 * demo seed. Money is integer cents throughout, per CLAUDE.md rule 1.
 */

export type PosProvider = "square" | "toast" | "clover" | "csv" | "demo";
export type ProcessingFeeStatus = "actual" | "estimated" | "missing";

export type PosOrderLine = {
  posItemId: string | null;
  name: string;
  quantity: number;
  netSalesCents: number;
  modifiers: { posModifierId: string; name: string }[];
  voided: boolean;
  voidedBy: string | null;
};

export type PosOrder = {
  posOrderId: string;
  posLocationId: string | null;
  closedAt: string; // ISO timestamp
  grossSalesCents: number;
  discountsCents: number;
  refundsCents: number;
  taxCents: number;
  tipCents: number;
  processingFeeCents: number;
  processingFeeStatus: ProcessingFeeStatus;
  netSalesCents: number;
  lines: PosOrderLine[];
};

export type PosCatalogItem = {
  posItemId: string;
  name: string;
  priceCents: number | null;
  category: string | null;
};

export type PosEmployee = {
  posTeamMemberId: string;
  displayName: string;
  role: string | null;
};

export type PosTimecardBreak = { start: string; end: string; paid: boolean };

export type PosTimecard = {
  posTimecardId: string;
  posTeamMemberId: string;
  clockIn: string;
  clockOut: string | null;
  hourlyWageCents: number;
  breaks: PosTimecardBreak[];
};

export type PosAdapter = {
  provider: PosProvider;
  /** Orders closed within [since, until), including their line items. */
  fetchOrders(range: { since: Date; until: Date }): Promise<PosOrder[]>;
  fetchCatalogItems(): Promise<PosCatalogItem[]>;
  fetchEmployees(): Promise<PosEmployee[]>;
  fetchTimecards(range: { since: Date; until: Date }): Promise<PosTimecard[]>;
};

export class PosNotConnectedError extends Error {
  constructor(provider: PosProvider) {
    super(`${provider} is not connected yet — needs OAuth credentials (see PROGRESS.md "Needs connecting").`);
    this.name = "PosNotConnectedError";
  }
}
