import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/client", () => ({ isSupabaseConfigured: vi.fn(() => true) }));
vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient: vi.fn() }));
vi.mock("./getActiveBusinessId", () => ({ getActiveBusinessId: vi.fn(),readActiveBusinessMemberships:vi.fn() }));
vi.mock("./fixtureSnapshot", () => ({ getFixtureSnapshot: () => ({ business: { name: "Demo café" } }) }));
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getActiveBusinessId,readActiveBusinessMemberships } from "./getActiveBusinessId";
import { getActiveCafeName } from "./getActiveCafeName";

describe("active café navigation identity", () => {
  beforeEach(() => vi.clearAllMocks());
  it("sends an owner without a real café to setup, never the shared demo", async () => {
    vi.mocked(readActiveBusinessMemberships).mockResolvedValue([] as never);
    const from = vi.fn();
    vi.mocked(createServerSupabaseClient).mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) }, from,
    } as never);
    expect(await getActiveCafeName()).toBe("Set up your café");
    expect(getActiveBusinessId).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });
  it("shows the real café when that business is active, with no hardcoding", async () => {
    vi.mocked(readActiveBusinessMemberships).mockResolvedValue([{business_id:"real-business",businesses:{is_demo:false}}] as never);
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
