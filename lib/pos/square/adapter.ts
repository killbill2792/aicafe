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
type SquarePayment = { order_id?: string; processing_fee?: { amount_money?: SquareMoney }[] };

function cents(money: SquareMoney | undefined): number {
  return money?.amount ?? 0;
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

      // Processing fees live on Payments, matched back to their order.
      const payments = await squarePaginated<SquarePayment>(
        accessToken,
        "/v2/payments",
        { location_id: locationId, begin_time: since.toISOString(), end_time: until.toISOString() },
        "payments",
      );
      const feeByOrder = new Map<string, number>();
      for (const payment of payments) {
        if (!payment.order_id) continue;
        const fee = (payment.processing_fee ?? []).reduce((sum, f) => sum + cents(f.amount_money), 0);
        feeByOrder.set(payment.order_id, (feeByOrder.get(payment.order_id) ?? 0) + fee);
      }

      const result: PosOrder[] = orders.map((order) => {
        const discounts = cents(order.total_discount_money);
        const refunds = (order.refunds ?? []).reduce((sum, r) => sum + cents(r.amount_money), 0);
        const gross = cents(order.total_money);
        const net = order.net_amounts?.total_money ? cents(order.net_amounts.total_money) : gross - discounts - refunds;

        return {
          posOrderId: order.id,
          posLocationId: order.location_id ?? locationId,
          closedAt: order.closed_at ?? order.created_at ?? new Date().toISOString(),
          grossSalesCents: gross,
          discountsCents: discounts,
          refundsCents: refunds,
          taxCents: cents(order.total_tax_money),
          tipCents: cents(order.total_tip_money),
          processingFeeCents: feeByOrder.get(order.id) ?? 0,
          netSalesCents: net,
          lines: (order.line_items ?? []).map((line) => ({
            posItemId: line.catalog_object_id ?? null,
            name: line.name ?? "Item",
            quantity: Number(line.quantity ?? "1"),
            netSalesCents: cents(line.total_money),
            modifiers: (line.modifiers ?? []).map((m) => ({ posModifierId: m.catalog_object_id ?? "", name: m.name ?? "" })),
            voided: false, // Square reports voids as a distinct order state / line note; refine once tested against a real account.
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
