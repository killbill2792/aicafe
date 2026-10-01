import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { copyRecipeLines } from "./copyRecipeLines";

type SourceItemResult = { data: { id: string } | null; error: unknown };
type SourceLinesResult = { data: Array<{ ingredient_id: string; quantity: number; display_unit: string | null; display_quantity: number | null }> | null; error: unknown };

function fakeSupabase(opts: {
  sourceItem: SourceItemResult;
  sourceLines?: SourceLinesResult;
  insertResult?: { error: unknown };
  onInsert?: (rows: unknown[]) => void;
}): SupabaseClient {
  return {
    from(table: string) {
      if (table === "menu_items") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => opts.sourceItem,
              }),
            }),
          }),
        };
      }
      if (table === "recipe_lines") {
        return {
          select: () => ({
            eq: async () => opts.sourceLines ?? { data: [], error: null },
          }),
          insert: async (rows: unknown[]) => {
            opts.onInsert?.(rows);
            return opts.insertResult ?? { error: null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

describe("copyRecipeLines", () => {
  it("fails when the source item doesn't belong to the active business", async () => {
    const onInsert = vi.fn();
    const supabase = fakeSupabase({ sourceItem: { data: null, error: null }, onInsert });
    const result = await copyRecipeLines(supabase, "biz-1", "other-biz-item", "new-item");
    expect(result).toBe(false);
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("fails when the source item query itself errors", async () => {
    const supabase = fakeSupabase({ sourceItem: { data: null, error: { message: "db down" } } });
    expect(await copyRecipeLines(supabase, "biz-1", "item-1", "new-item")).toBe(false);
  });

  it("fails when the source recipe-lines query errors", async () => {
    const supabase = fakeSupabase({
      sourceItem: { data: { id: "item-1" }, error: null },
      sourceLines: { data: null, error: { message: "db down" } },
    });
    expect(await copyRecipeLines(supabase, "biz-1", "item-1", "new-item")).toBe(false);
  });

  it("succeeds with zero lines copied when the source recipe is legitimately empty", async () => {
    const onInsert = vi.fn();
    const supabase = fakeSupabase({
      sourceItem: { data: { id: "item-1" }, error: null },
      sourceLines: { data: [], error: null },
      onInsert,
    });
    expect(await copyRecipeLines(supabase, "biz-1", "item-1", "new-item")).toBe(true);
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("copies every line onto the new item when the insert succeeds", async () => {
    const onInsert = vi.fn();
    const supabase = fakeSupabase({
      sourceItem: { data: { id: "item-1" }, error: null },
      sourceLines: { data: [{ ingredient_id: "milk", quantity: 236.6, display_unit: "fl_oz", display_quantity: 8 }], error: null },
      onInsert,
    });
    expect(await copyRecipeLines(supabase, "biz-1", "item-1", "new-item")).toBe(true);
    expect(onInsert).toHaveBeenCalledWith([{ menu_item_id: "new-item", ingredient_id: "milk", quantity: 236.6, display_unit: "fl_oz", display_quantity: 8 }]);
  });

  it("reports failure, not success, when the copy insert itself fails", async () => {
    const supabase = fakeSupabase({
      sourceItem: { data: { id: "item-1" }, error: null },
      sourceLines: { data: [{ ingredient_id: "milk", quantity: 1, display_unit: "g", display_quantity: 1 }], error: null },
      insertResult: { error: { message: "constraint violation" } },
    });
    expect(await copyRecipeLines(supabase, "biz-1", "item-1", "new-item")).toBe(false);
  });
});
