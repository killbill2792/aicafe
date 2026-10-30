import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  user: vi.fn(),
  active: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({isSupabaseConfigured: () => true}));
vi.mock("@/lib/auth/requireUser", () => ({getOptionalAuthenticatedUser: state.user}));
vi.mock("./getActiveBusinessId", () => ({getActiveBusinessId: state.active}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: {getUser: () => {throw new Error("Unexpected duplicate Auth call");}},
    from: state.from,
  }),
}));

import {getUploadHistory} from "./getUploadHistory";

describe("More upload badge reuses the request's authenticated user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user.mockResolvedValue({id: "owner"});
    state.active.mockResolvedValue("cafe-a");
    state.from.mockImplementation((table: string) => {
      if (table !== "uploads") throw new Error("Unexpected table " + table);
      return {
        select() {return this;},
        eq() {return this;},
        in() {return this;},
        order() {return this;},
        limit() {return Promise.resolve({data: [
          {id: "a", kind: "sales_csv", status: "needs_review",
            created_at: "2026-10-29T12:00:00Z", summary: null},
        ], error: null});},
      };
    });
  });

  it("preserves scoped upload results without repeating the Auth network lookup", async () => {
    const result = await getUploadHistory();
    expect(result).toEqual([{
      id: "a", kind: "sales_csv", status: "needs_review",
      createdAt: "2026-10-29T12:00:00Z", summary: null,
    }]);
    expect(state.user).toHaveBeenCalledOnce();
    expect(state.active).toHaveBeenCalledWith("owner");
    expect(state.from).toHaveBeenCalledOnce();
    expect(state.from).toHaveBeenCalledWith("uploads");
  });

  it("does not read uploads when the request is unauthenticated", async () => {
    state.user.mockResolvedValue(null);
    expect(await getUploadHistory()).toEqual([]);
    expect(state.active).not.toHaveBeenCalled();
    expect(state.from).not.toHaveBeenCalled();
  });
});
