import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuControlItem } from "./getMenuControlCenter";

vi.mock("server-only", () => ({}));
const deps = vi.hoisted(() => ({ client: vi.fn(), sign: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: () => true }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: deps.client }));
vi.mock("./getActiveBusinessId", () => ({ getActiveBusinessId: async () => "cafe-one" }));
import { getMenuCatalogPhotos } from "./getProductPhoto";

function items() {
  return [
    { id: "latte-small", baseName: "Latte" },
    { id: "latte-large", baseName: "Latte" },
    { id: "tea", baseName: "Tea" },
  ] as MenuControlItem[];
}
function db(rows: { anchor_menu_item_id: string; storage_path: string }[]) {
  const from = () => {
    const query = {
      select: () => query, eq: () => query, in: () => Promise.resolve({ data: rows, error: null }),
    };
    return query;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) },
    from, storage: { from: () => ({ createSignedUrls: deps.sign }) },
  };
}
describe("catalog photos retain family/tenant semantics after deferred delivery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("signs once and returns every photographed size under its own id", async () => {
    deps.client.mockResolvedValue(db([{ anchor_menu_item_id: "latte-small", storage_path: "cafe/latte" }]));
    deps.sign.mockResolvedValue({ data: [{ path: "cafe/latte", signedUrl: "https://photos.test/signed" }] });
    const photos = await getMenuCatalogPhotos(items());
    expect(photos["latte-small"]).toEqual({ signedUrl: "https://photos.test/signed", storagePath: "cafe/latte" });
    expect(photos["latte-large"]).toEqual(photos["latte-small"]);
    expect(photos["tea"]).toBeUndefined();
    expect(deps.sign).toHaveBeenCalledTimes(1);
    expect(deps.sign).toHaveBeenCalledWith(["cafe/latte"], 3600);
  });

  it("never invents a photo when storage returns no signed URL", async () => {
    deps.client.mockResolvedValue(db([{ anchor_menu_item_id: "latte-small", storage_path: "cafe/latte" }]));
    deps.sign.mockResolvedValue({ data: [] });
    expect(await getMenuCatalogPhotos(items())).toEqual({});
  });
});
