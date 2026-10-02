import { describe, expect, it, vi } from "vitest";
import { executeGroupedProductRename } from "./renameProduct";

describe("grouped product rename action boundary", () => {
  it("passes the authenticated business and selected sibling to the atomic grouped RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    await executeGroupedProductRename({ rpc }, "business-a", "20-ounce-id", "  Americano  ");
    expect(rpc).toHaveBeenCalledWith("rename_menu_product", {
      target_business_id: "business-a",
      target_menu_item_id: "20-ounce-id",
      new_base_name: "Americano",
    });
  });
});
