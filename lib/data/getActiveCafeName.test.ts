import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: vi.fn(() => true) }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("./getActiveBusinessId", () => ({ getActiveBusinessId: vi.fn() }));
vi.mock("./fixtureSnapshot", () => ({ getFixtureSnapshot: () => ({ business: { name: "Demo café" } }) }));
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId } from "./getActiveBusinessId";
import { getActiveCafeName } from "./getActiveCafeName";

describe("active café navigation identity", () => {
  beforeEach(() => vi.clearAllMocks());
  it("looks up the active demo café name when the owner has switched to Demo", async () => {
    vi.mocked(getActiveBusinessId).mockResolvedValue("demo-business");
    const maybeSingle = vi.fn(async () => ({ data: { name: "Demo café" }, error: null }));
    const eq = vi.fn(() => ({ maybeSingle }));
    const from = vi.fn(() => ({ select: () => ({ eq }) }));
    vi.mocked(createServerSupabaseClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) }, from,
    } as never);
    expect(await getActiveCafeName()).toBe("Demo café");
    expect(getActiveBusinessId).toHaveBeenCalledWith("owner");
    expect(eq).toHaveBeenCalledWith("id", "demo-business");
  });
  it("shows the real café when that business is active, with no hardcoding", async () => {
    vi.mocked(getActiveBusinessId).mockResolvedValue("real-business");
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: { name: "Raj Café" }, error: null }) }));
    vi.mocked(createServerSupabaseClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) },
      from: () => ({ select: () => ({ eq }) }),
    } as never);
    expect(await getActiveCafeName()).toBe("Raj Café");
    expect(eq).toHaveBeenCalledWith("id", "real-business");
  });
});
