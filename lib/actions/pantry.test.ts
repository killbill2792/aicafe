import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "@/lib/data/getActiveBusinessId";
import { applyTemplate, savePackPrice, addFromStarter } from "./pantry";
import { packToCostPerBaseMicros } from "@/lib/calc/recipeUnits";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("@/lib/data/getActiveBusinessId", () => ({ getActiveBusinessId: vi.fn() }));
vi.mock("@/lib/data/queryError", () => ({
  logQueryError: vi.fn(), MENU_SAVE_FAILURE_MESSAGE: "Unable to save.",
  MENU_LOAD_FAILURE_MESSAGE: "Unable to load.",
}));

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const INGREDIENT = "22222222-2222-4222-8222-222222222222";
const PRODUCT = "33333333-3333-4333-8333-333333333333";

function fakeDb(ownIngredient: boolean) {
  const insertPrice = vi.fn(async () => ({ error: null }));
  const rpc = vi.fn();
  const from = vi.fn((table: string) => {
    if (table === "businesses") return {
      select: () => ({ eq: () => ({ single: async () => ({ data: { timezone: "America/Los_Angeles" }, error: null }) }) }),
    };
    if (table === "ingredients") return {
      select: () => ({
        eq: () => ({
          eq: () => ({ single: async () => ({
            data: ownIngredient ? { id: INGREDIENT, base_unit: "ml" } : null, error: null,
          }) }),
          in: async () => ({ data: [], error: null, count: 0 }),
        }),
      }),
    };
    if (table === "menu_items") return {
      select: () => ({ eq: () => ({
        eq: () => ({ single: async () => ({ data: { id: PRODUCT }, error: null }) }),
      }) }),
    };
    if (table === "ingredient_prices") return { insert: insertPrice };
    throw new Error(`Unexpected table ${table}`);
  });
  const db = { auth: { getUser: async () => ({ data: { user: { id: "user" } } }) },
    from, rpc };
  return { db, from, rpc, insertPrice };
}

beforeEach(() => {
  vi.mocked(getActiveBusinessId).mockResolvedValue(BUSINESS);
});
describe("pantry actions authorization and validation", () => {
  it("rejects bad inputs before accessing private data", async () => {
    vi.mocked(createServerSupabaseClient).mockClear();
    expect((await savePackPrice({ ingredientId: INGREDIENT, packQuantity: 0,
      packUnit: "gal", packCostCents: 1999 })).ok).toBe(false);
    expect((await addFromStarter(["not-a-starter"])).ok).toBe(false);
    expect((await applyTemplate(PRODUCT, "not-a-template" as never)).ok).toBe(false);
    expect(createServerSupabaseClient).not.toHaveBeenCalled();
  });
  it("requires the ingredient to belong to the active business", async () => {
    const { db, insertPrice } = fakeDb(false);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(db as never);
    const result = await savePackPrice({
      ingredientId: INGREDIENT, packQuantity: 1, packUnit: "gal", packCostCents: 1999,
    });
    expect(result).toEqual({ ok: false, error: "ingredient_not_found" });
    expect(insertPrice).not.toHaveBeenCalled();
  });
  it("writes a dated canonical price and keeps the original purchase pack facts", async () => {
    const { db, insertPrice, from } = fakeDb(true);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(db as never);
    const result = await savePackPrice({
      ingredientId: INGREDIENT, packQuantity: 1, packUnit: "gal", packCostCents: 1999,
    });
    expect(result).toEqual({ ok: true });
    expect(from).toHaveBeenCalledWith("ingredients");
    expect(insertPrice).toHaveBeenCalledWith(expect.objectContaining({
      ingredient_id: INGREDIENT, source: "manual", pack_quantity: 1,
      pack_unit: "gal", pack_cost_cents: 1999,
      cost_per_base_unit_micros: packToCostPerBaseMicros(1, "gal", 1999, "ml"),
    }));
  });
  it("does not apply a template or write a partial recipe if required pantry items are missing", async () => {
    const { db, rpc } = fakeDb(false);
    vi.mocked(createServerSupabaseClient).mockResolvedValue(db as never);
    const result = await applyTemplate(PRODUCT, "latte");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing_pantry");
      expect(result.missingPantry).toContain("espresso-beans");
      expect(result.missingPantry).toContain("cup-hot-12");
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});
