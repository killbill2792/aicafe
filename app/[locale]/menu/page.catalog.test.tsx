import { Children, isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const deps = vi.hoisted(() => ({
  auth: vi.fn(), menu: vi.fn(), matches: vi.fn(), unpriced: vi.fn(),
  photos: vi.fn(), timed: vi.fn(async (_page: string, _stage: string, read: () => Promise<unknown>) => read()),
}));
vi.mock("@/lib/auth/requireUser", () => ({ requireOwnBusiness: deps.auth }));
vi.mock("@/lib/data/getMenuControlCenter", () => ({ getMenuControlCenter: deps.menu }));
vi.mock("@/lib/data/getCatalogMatchReview", () => ({ getCatalogMatchReview: deps.matches }));
vi.mock("@/lib/data/getUnpricedPublishedMenu", () => ({ getUnpricedPublishedMenu: deps.unpriced }));
vi.mock("@/lib/data/getProductPhoto", () => ({ getMenuCatalogPhotos: deps.photos }));
vi.mock("@/lib/perf/timeReader.server", () => ({ timeReader: deps.timed }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "en",
}));
vi.mock("@/components/menu/MenuCatalog", () => ({ default: () => null }));
vi.mock("@/i18n/navigation", () => ({ Link: "a" }));
vi.mock("@/components/shared/PageShell", () => ({ default: "main" }));

import MenuPage from "./page";

function catalogProps(page: ReactElement) {
  const nodes = Children.toArray((page.props as { children: React.ReactNode }).children);
  const catalog = nodes.find((node) => isValidElement(node) &&
    "photosPromise" in (node.props as object));
  if (!isValidElement(catalog)) throw new Error("Menu catalog missing");
  return catalog.props as { items: unknown[]; photosPromise: Promise<Record<string, unknown>> };
}

describe("Menu catalog first-use render", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deps.auth.mockResolvedValue(undefined);
    deps.menu.mockResolvedValue([{ id: "latte", priceCents: 550 }]);
    deps.matches.mockResolvedValue([]);
    deps.unpriced.mockResolvedValue([]);
  });

  it("returns usable catalog before signed photos settle, without starting a second menu reader", async () => {
    // This promise never settles. Awaiting photos in MenuPage would time out.
    deps.photos.mockReturnValue(new Promise(() => {}));
    const page = await MenuPage();
    const { items, photosPromise } = catalogProps(page);
    expect(items).toEqual([{ id: "latte", priceCents: 550 }]);
    expect(photosPromise).toBeInstanceOf(Promise);
    expect(deps.menu).toHaveBeenCalledTimes(1);
    expect(deps.menu).toHaveBeenCalledWith({ catalogOnly: true });
    expect(deps.photos).toHaveBeenCalledTimes(1);
    expect(deps.timed).toHaveBeenCalledWith("Menu", "signedPhotos", expect.any(Function));
  });

  it("delivers signed photos unchanged after the catalog becomes usable", async () => {
    const urls = { latte: { signedUrl: "https://photos.test/signed", storagePath: "menu/latte" } };
    deps.photos.mockResolvedValue(urls);
    const props = catalogProps(await MenuPage());
    expect(await props.photosPromise).toEqual(urls);
  });

  it("keeps catalog usable and avoids leaking storage errors on a photo failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      deps.photos.mockRejectedValue(new Error("private signed URL information"));
      const props = catalogProps(await MenuPage());
      expect(props.items).toHaveLength(1);
      expect(await props.photosPromise).toEqual({});
      expect(warn).toHaveBeenCalledWith("[menu-photos] signed_photo_read_failed");
    } finally {
      warn.mockRestore();
    }
  });
});
