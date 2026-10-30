import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const deps = vi.hoisted(() => ({
  catalog: vi.fn(),
  pricing: vi.fn(),
  viewModel: vi.fn(),
  dailyFacts: vi.fn(),
  timed: vi.fn(async (_page: string, _stage: string, read: () => Promise<unknown>) => read()),
  createClient: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: deps.createClient }));
vi.mock("./getActiveBusinessId", () => ({ getActiveBusinessId: async () => "cafe-one" }));
vi.mock("./getMenuItemsForEdit", () => ({ getMenuItemsForEdit: deps.catalog }));
vi.mock("./getPricingInputs", () => ({ getPricingInputs: deps.pricing }));
vi.mock("@/lib/viewmodels/pricingViewModel", () => ({ buildPricingViewModel: deps.viewModel }));
vi.mock("./dailyFacts.server", () => ({ readDailyFactRows: deps.dailyFacts }));
vi.mock("@/lib/perf/timeReader.server", () => ({ timeReader: deps.timed }));

import { getMenuControlCenter } from "./getMenuControlCenter";

function clientWithEvidenceReads(reads: string[], failOrders = false) {
  const values: Record<string, unknown> = {
    businesses: { timezone: "America/Los_Angeles" },
    order_lines: [],
    menu_price_history: [],
    menu_market_price_observations: [],
    pos_connections: [],
  };
  const from = (table: string) => {
    reads.push(table);
    const response = () => ({
      data: values[table] ?? [],
      error: table === "order_lines" && failOrders ? { message: "unavailable" } : null,
    });
    const query = {
      select: () => query, eq: () => query, in: () => query, is: () => query,
      gte: () => query, lte: () => query, order: () => query,
      single: async () => response(),
      then: (resolve: (value: ReturnType<typeof response>) => unknown) =>
        Promise.resolve(response()).then(resolve),
    };
    return query;
  };
  return { auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) }, from };
}

const latte = {
  id: "latte", name: "Latte", baseName: "Latte", priceCents: 550, sizeLabel: null,
  active: true, costStatus: "READY", ingredientsCostCents: 130,
  recipe: [{ ingredientId: "milk", quantity: 200, costCents: 70 }],
  catalogSource: "manual", catalogLastSyncedAt: null, posItemId: null,
};

describe("one canonical menu reader: catalog versus full item evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.catalog.mockResolvedValue({ items: [latte], ingredients: [] });
    deps.dailyFacts.mockResolvedValue([]);
    deps.pricing.mockResolvedValue({
      items: [{ id: "latte", unitsSoldInWindow: 24 }],
      business: { targetOperatingMargin: 0.15, targetOperatingMarginStatus: "default" },
      menuPriceBasis: { source: "shared" },
    });
    deps.viewModel.mockReturnValue([{
      itemId: "latte", result: {
        status: "KEEP_CURRENT_PRICE", currentPriceCents: 550,
        recommendedPriceCents: 550, baselinePriceCents: 550,
      },
    }]);
  });

  it("catalog skips historical line/market/price-change evidence yet retains exact shared prices, recipe and quantities", async () => {
    const reads: string[] = [];
    deps.createClient.mockResolvedValue(clientWithEvidenceReads(reads));
    const catalog = await getMenuControlCenter({ catalogOnly: true });
    expect(reads).toEqual([]);
    expect(deps.dailyFacts).not.toHaveBeenCalled();
    expect(deps.pricing).toHaveBeenCalledWith(
      expect.anything(), "cafe-one", { attentionOnly: false, profile: "Menu" },
    );

    const full = await getMenuControlCenter();
    expect(reads).toContain("order_lines");
    expect(reads).toContain("menu_price_history");
    expect(reads).toContain("menu_market_price_observations");
    expect(reads).toContain("pos_connections");
    expect(deps.dailyFacts).toHaveBeenCalledTimes(1);
    expect(catalog).toHaveLength(full.length);
    expect(catalog[0].id).toBe(full[0].id);
    expect(catalog[0].priceCents).toBe(full[0].priceCents);
    expect(catalog[0].recipe).toEqual(full[0].recipe);
    expect(catalog[0].ingredientsCostCents).toBe(full[0].ingredientsCostCents);
    expect(catalog[0].unitsSold).toBe(full[0].unitsSold);
    expect(catalog[0].pricing).toEqual(full[0].pricing);
    expect(catalog[0].pricingBasis).toEqual(full[0].pricingBasis);
    const beforeBytes = Buffer.byteLength(JSON.stringify(full), "utf8");
    const afterBytes = Buffer.byteLength(JSON.stringify(catalog), "utf8");
    expect(afterBytes).toBeLessThan(beforeBytes);
    console.info("[menu-fixture] full_dto_bytes=" + beforeBytes + " catalog_dto_bytes=" + afterBytes);
    expect(full[0].pricingEvidence).toHaveProperty("salesResponse");
    expect(catalog[0].revenueCents).toBeNull();
    expect(deps.timed).toHaveBeenCalledWith("Menu", "menu.pricingInputs", expect.any(Function));
  });

  it("does not use a fabricated catalog price when the canonical pricing read fails", async () => {
    deps.createClient.mockResolvedValue(clientWithEvidenceReads([]));
    deps.pricing.mockRejectedValueOnce(new Error("pricing read failed"));
    await expect(getMenuControlCenter({ catalogOnly: true })).rejects.toThrow("pricing read failed");
  });

  it("keeps the full detail reader's evidence error instead of silently replacing missing sales with zeros", async () => {
    deps.createClient.mockResolvedValue(clientWithEvidenceReads([], true));
    await expect(getMenuControlCenter()).rejects.toThrow();
    await expect(getMenuControlCenter({ catalogOnly: true })).resolves.toHaveLength(1);
  });
});
