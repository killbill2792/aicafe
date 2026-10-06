import "server-only";
import { squarePaginated, squareRequest } from "./client";
import type { PosAdapter, PosCatalogItem, PosEmployee, PosOrder, PosTimecard } from "../types";

type SquareMoney = { amount?: number; currency?: string };
type SquareOrderLineItem = {
  catalog_object_id?: string;
  name?: string;
  quantity?: string;
  total_money?: SquareMoney;
  modifiers?: { catalog_object_id?: string; name?: string }[];
};
type SquareOrder = {
  id: string;
  location_id?: string;
  closed_at?: string;
  created_at?: string;
  total_money?: SquareMoney;
  total_discount_money?: SquareMoney;
  total_tax_money?: SquareMoney;
  total_tip_money?: SquareMoney;
  net_amounts?: { total_money?: SquareMoney };
  line_items?: SquareOrderLineItem[];
  refunds?: { amount_money?: SquareMoney }[];
};
type SquarePayment = {
  order_id?: string;
  status?: string;
  source_type?: string;
  processing_fee?: { amount_money?: SquareMoney }[];
};

function cents(money: SquareMoney | undefined): number {
  return money?.amount ?? 0;
}

/** Normalize one already-netted Square fee amount into AI Cafe's positive-cost convention. */
export function normalizeSquareProcessingFeeCents(netAmountCents: number): number {
  return Math.abs(Math.round(netAmountCents));
}

function classifySquarePaymentFee(payment: SquarePayment): { applicable: boolean; complete: boolean; amountCents: number } {
  const status = payment.status?.toUpperCase();
  if (status === "FAILED" || status === "CANCELED") return { applicable: false, complete: true, amountCents: 0 };
  if (status !== "COMPLETED") return { applicable: true, complete: false, amountCents: 0 };

  const sourceType = payment.source_type?.toUpperCase();
  if (sourceType === "CASH" || sourceType === "EXTERNAL") {
    return { applicable: true, complete: true, amountCents: 0 };
  }

  if (payment.processing_fee !== undefined) {
    const signedNet = payment.processing_fee.reduce((sum, entry) => sum + cents(entry.amount_money), 0);
    return { applicable: true, complete: true, amountCents: normalizeSquareProcessingFeeCents(signedNet) };
  }

  // Completed fee-bearing/unknown tender with no fee yet: remain conservative until Square
  // supplies the processing_fee entries on a later sync.
  return { applicable: true, complete: false, amountCents: 0 };
}

/**
 * Maps Square's Orders/Payments/Catalog/Team-Member/Timecard APIs onto the shared PosAdapter
 * shape. Field names follow Square's documented v2 API as of Square-Version 2025-05-21 — confirm
 * against Square's current docs before relying on this against a live merchant (per
 * docs/06-integrations.md), and verify one day's totals against Square's own Sales Summary /
 * Labor reports before trusting a real sync.
 */
export function createSquareAdapter(params: { accessToken: string; locationId: string }): PosAdapter {
  const { accessToken, locationId } = params;

  return {
    provider: "square",

    async fetchOrders({ since, until }) {
      const orders = await squarePaginated<SquareOrder>(
        accessToken,
        "/v2/orders/search",
        {
          location_ids: [locationId],
          query: {
            filter: {
              date_time_filter: { closed_at: { start_at: since.toISOString(), end_at: until.toISOString() } },
              state_filter: { states: ["COMPLETED"] },
            },
            sort: { sort_field: "CLOSED_AT", sort_order: "ASC" },
          },
          limit: 500,
        },
        "orders",
      );

      // Processing fees live on Payments, matched back to their order. Failed/canceled attempts
      // are ignored; legitimate zero-fee completed tenders count as complete actual zero.
      const payments = await squarePaginated<SquarePayment>(
        accessToken,
        "/v2/payments",
        { location_id: locationId, begin_time: since.toISOString(), end_time: until.toISOString() },
        "payments",
      );
      const feeByOrder = new Map<string, { amountCents: number; complete: boolean; applicableCount: number }>();
      for (const payment of payments) {
        if (!payment.order_id) continue;
        const classified = classifySquarePaymentFee(payment);
        if (!classified.applicable) continue;
        const prior = feeByOrder.get(payment.order_id) ?? { amountCents: 0, complete: true, applicableCount: 0 };
        feeByOrder.set(payment.order_id, {
          amountCents: prior.amountCents + classified.amountCents,
          complete: prior.complete && classified.complete,
          applicableCount: prior.applicableCount + 1,
        });
      }

      const result: PosOrder[] = orders.map((order) => {
        const discounts = cents(order.total_discount_money);
        const refunds = (order.refunds ?? []).reduce((sum, r) => sum + cents(r.amount_money), 0);
        const gross = cents(order.total_money);
        const net = order.net_amounts?.total_money ? cents(order.net_amounts.total_money) : gross - discounts - refunds;

        const processingFee = feeByOrder.get(order.id);
        const processingFeeComplete = Boolean(processingFee && processingFee.applicableCount > 0 && processingFee.complete);
        return {
          posOrderId: order.id,
          posLocationId: order.location_id ?? locationId,
          closedAt: order.closed_at ?? order.created_at ?? new Date().toISOString(),
          grossSalesCents: gross,
          discountsCents: discounts,
          refundsCents: refunds,
          taxCents: cents(order.total_tax_money),
          tipCents: cents(order.total_tip_money),
          processingFeeCents: processingFee?.amountCents ?? 0,
          processingFeeStatus: processingFeeComplete ? "actual" : "missing",
          netSalesCents: net,
          lines: (order.line_items ?? []).map((line) => ({
            posItemId: line.catalog_object_id ?? null,
            name: line.name ?? "Item",
            quantity: Number(line.quantity ?? "1"),
            netSalesCents: cents(line.total_money),
            modifiers: (line.modifiers ?? []).map((m) => ({ posModifierId: m.catalog_object_id ?? "", name: m.name ?? "" })),
            voided: false,
            voidedBy: null,
          })),
        };
      });

      return result;
    },

    async fetchCatalogItems(): Promise<PosCatalogItem[]> {
      type CatalogObject = {
        id: string;
        type: string;
        item_data?: { name?: string; category_id?: string; variations?: { item_variation_data?: { price_money?: SquareMoney } }[] };
      };
      const data = await squareRequest<{ objects?: CatalogObject[] }>(accessToken, "/v2/catalog/list?types=ITEM");
      return (data.objects ?? [])
        .filter((o) => o.type === "ITEM")
        .map((o) => ({
          posItemId: o.id,
          name: o.item_data?.name ?? "Item",
          priceCents: cents(o.item_data?.variations?.[0]?.item_variation_data?.price_money) || null,
          category: o.item_data?.category_id ?? null,
        }));
    },

    async fetchEmployees(): Promise<PosEmployee[]> {
      type TeamMember = { id: string; given_name?: string; family_name?: string; status?: string };
      const data = await squareRequest<{ team_members?: TeamMember[] }>(accessToken, "/v2/team-members/search", {
        method: "POST",
        body: { query: { filter: { status: "ACTIVE" } } },
      });
      return (data.team_members ?? []).map((m) => ({
        posTeamMemberId: m.id,
        displayName: [m.given_name, m.family_name].filter(Boolean).join(" ") || "Team member",
        role: null,
      }));
    },

    async fetchTimecards({ since, until }): Promise<PosTimecard[]> {
      type Timecard = {
        id: string;
        team_member_id: string;
        start_at?: string;
        end_at?: string;
        wage?: { hourly_rate?: SquareMoney };
        breaks?: { start_at?: string; end_at?: string; is_paid?: boolean }[];
      };
      const timecards = await squarePaginated<Timecard>(
        accessToken,
        "/v2/labor/timecards/search",
        { query: { filter: { location_ids: [locationId], start: { start_at: since.toISOString(), end_at: until.toISOString() } } } },
        "timecards",
      );
      return timecards
        .filter((tc) => tc.start_at)
        .map((tc) => ({
          posTimecardId: tc.id,
          posTeamMemberId: tc.team_member_id,
          clockIn: tc.start_at!,
          clockOut: tc.end_at ?? null,
          hourlyWageCents: cents(tc.wage?.hourly_rate),
          breaks: (tc.breaks ?? [])
            .filter((b) => b.start_at && b.end_at)
            .map((b) => ({ start: b.start_at!, end: b.end_at!, paid: Boolean(b.is_paid) })),
        }));
    },
  };
}
