import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSquareAdapter, normalizeSquareProcessingFeeCents } from "./adapter";
import { squarePaginated } from "./client";

vi.mock("./client", () => ({ squarePaginated: vi.fn(), squareRequest: vi.fn() }));

const order = { id: "order-1", closed_at: "2026-10-02T12:00:00Z", total_money: { amount: 1_500 }, line_items: [] };
const range = { since: new Date("2026-10-02T00:00:00Z"), until: new Date("2026-10-03T00:00:00Z") };

beforeEach(() => vi.mocked(squarePaginated).mockReset());

async function fetchWithPayments(payments: unknown[]) {
  vi.mocked(squarePaginated).mockResolvedValueOnce([order]).mockResolvedValueOnce(payments);
  return (await createSquareAdapter({ accessToken: "secret", locationId: "location" }).fetchOrders(range))[0];
}

describe("Square processing fees", () => {
  it("normalizes one already-netted signed fee into positive processing cost", () => {
    expect(normalizeSquareProcessingFeeCents(-44)).toBe(44);
    expect(normalizeSquareProcessingFeeCents(44)).toBe(44);
    expect(normalizeSquareProcessingFeeCents(0)).toBe(0);
  });

  it("maps a completed card fee to positive actual provenance", async () => {
    expect(await fetchWithPayments([{
      order_id: "order-1", status: "COMPLETED", source_type: "CARD",
      processing_fee: [{ amount_money: { amount: -44 } }],
    }])).toMatchObject({ processingFeeCents: 44, processingFeeStatus: "actual" });
  });

  it("nets mixed-sign fee adjustments before normalizing the final cost", async () => {
    expect(await fetchWithPayments([{
      order_id: "order-1", status: "COMPLETED", source_type: "CARD",
      processing_fee: [{ amount_money: { amount: -44 } }, { amount_money: { amount: 10 } }],
    }])).toMatchObject({ processingFeeCents: 34, processingFeeStatus: "actual" });
  });

  it("treats completed cash as known actual zero", async () => {
    expect(await fetchWithPayments([{ order_id: "order-1", status: "COMPLETED", source_type: "CASH" }]))
      .toMatchObject({ processingFeeCents: 0, processingFeeStatus: "actual" });
  });

  it("treats completed external tender as known actual zero", async () => {
    expect(await fetchWithPayments([{ order_id: "order-1", status: "COMPLETED", source_type: "EXTERNAL" }]))
      .toMatchObject({ processingFeeCents: 0, processingFeeStatus: "actual" });
  });

  it("keeps a completed card missing until Square exposes its fee", async () => {
    expect(await fetchWithPayments([{ order_id: "order-1", status: "COMPLETED", source_type: "CARD" }]))
      .toMatchObject({ processingFeeCents: 0, processingFeeStatus: "missing" });
  });

  it("keeps pending/approved economically applicable payments incomplete", async () => {
    expect(await fetchWithPayments([{ order_id: "order-1", status: "PENDING", source_type: "CARD" }]))
      .toMatchObject({ processingFeeStatus: "missing" });
  });

  it("ignores failed/canceled attempts when a completed payment is valid", async () => {
    expect(await fetchWithPayments([
      { order_id: "order-1", status: "FAILED", source_type: "CARD" },
      { order_id: "order-1", status: "CANCELED", source_type: "CARD" },
      { order_id: "order-1", status: "COMPLETED", source_type: "CARD", processing_fee: [{ amount_money: { amount: -44 } }] },
    ])).toMatchObject({ processingFeeCents: 44, processingFeeStatus: "actual" });
  });

  it("supports split tender with card fee plus legitimate zero-fee cash", async () => {
    expect(await fetchWithPayments([
      { order_id: "order-1", status: "COMPLETED", source_type: "CARD", processing_fee: [{ amount_money: { amount: -44 } }] },
      { order_id: "order-1", status: "COMPLETED", source_type: "CASH" },
      { order_id: "order-1", status: "FAILED", source_type: "CARD" },
    ])).toMatchObject({ processingFeeCents: 44, processingFeeStatus: "actual" });
  });

  it("allows a later resync to move a card fee from missing to actual", async () => {
    vi.mocked(squarePaginated)
      .mockResolvedValueOnce([order])
      .mockResolvedValueOnce([{ order_id: "order-1", status: "COMPLETED", source_type: "CARD" }])
      .mockResolvedValueOnce([order])
      .mockResolvedValueOnce([{
        order_id: "order-1", status: "COMPLETED", source_type: "CARD",
        processing_fee: [{ amount_money: { amount: -44 } }],
      }]);
    const adapter = createSquareAdapter({ accessToken: "secret", locationId: "location" });
    expect((await adapter.fetchOrders(range))[0]).toMatchObject({ processingFeeCents: 0, processingFeeStatus: "missing" });
    expect((await adapter.fetchOrders(range))[0]).toMatchObject({ processingFeeCents: 44, processingFeeStatus: "actual" });
  });
});
