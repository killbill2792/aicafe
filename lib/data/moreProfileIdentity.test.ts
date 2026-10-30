import {beforeEach, describe, expect, it, vi} from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({
  user: vi.fn(),
  memberships: vi.fn(),
  active: vi.fn(),
  location: vi.fn(),
  uploads: vi.fn(),
  from: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({isSupabaseConfigured: () => true}));
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => ({
    auth: {getUser: () => {throw new Error("Unexpected duplicate auth request");}},
    from: state.from,
  }),
}));
vi.mock("@/lib/auth/requireUser", () => ({
  getOptionalAuthenticatedUser: state.user,
}));
vi.mock("./getActiveBusinessId", () => ({
  getActiveBusinessId: state.active,
  readActiveBusinessMemberships: state.memberships,
}));
vi.mock("./cafeLocation.server", () => ({readPrimaryLocation: state.location}));
vi.mock("./getUploadHistory", () => ({getUploadHistory: state.uploads}));

import {getCafeProfile} from "./getCafeProfile";
import {getMoreBadgeInputs} from "./getMoreBadges";
import {buildMoreBadges} from "@/lib/viewmodels/moreBadges";

const demo = {business_id: "demo", role: "owner", businesses: {
  is_demo: true, name: "Demo", currency: "USD", timezone: "UTC", opened_on: null,
}};
const cafe = {business_id: "cafe-a", role: "staff", businesses: {
  is_demo: false, name: "Café del Sol", currency: "EUR",
  timezone: "Europe/Madrid", opened_on: "2024-04-11",
}};

function mockBadgeQueries() {
  state.from.mockImplementation((table: string) => {
    if (table === "memberships") throw new Error("Redundant membership query");
    const response = table === "recurring_costs"
      ? {data: [], error: null}
      : table === "alerts"
        ? {data: null, count: 3, error: null}
        : {data: [], error: null};
    return {
      select() {return this;},
      eq() {return this;},
      gte() {return this;},
      lte() {return this;},
      is() {return this;},
      in() {return this;},
      order() {return this;},
      limit() {return this;},
      maybeSingle: async () => ({data: {open_hours: null}, error: null}),
      then: (resolve: (value: typeof response) => unknown) => Promise.resolve(response).then(resolve),
    };
  });
}

describe("PR 10: More and café profile share authenticated identity reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.user.mockResolvedValue({id: "owner-1"});
    state.memberships.mockResolvedValue([demo, cafe]);
    state.active.mockResolvedValue("cafe-a");
    state.uploads.mockResolvedValue([
      {id: "upload-review", status: "needs_review"},
      {id: "upload-done", status: "done"},
    ]);
  });

  it("uses the already-authenticated, RLS-scoped real café for profile, never the active demo", async () => {
    state.active.mockResolvedValue("demo");
    state.location.mockResolvedValue({
      name: "Main shop", address_line1: "7 Market St", address_line2: null,
      city: "Madrid", region: null, postal_code: "28001", country_code: "ES",
      open_hours: null,
    });
    const profile = await getCafeProfile();
    expect(profile).toMatchObject({
      name: "Café del Sol", currency: "EUR", timezone: "Europe/Madrid",
      openedOn: "2024-04-11", locationName: "Main shop",
      addressLine1: "7 Market St", city: "Madrid", countryCode: "ES",
    });
    expect(state.user).toHaveBeenCalledOnce();
    expect(state.memberships).toHaveBeenCalledOnce();
    expect(state.memberships).toHaveBeenCalledWith("owner-1");
    expect(state.location).toHaveBeenCalledWith(expect.anything(), "cafe-a");
    expect(state.from).not.toHaveBeenCalled();
  });

  it("does not load a café or location for a signed-out user", async () => {
    state.user.mockResolvedValue(null);
    const profile = await getCafeProfile();
    expect(profile.name).toBe("My café");
    expect(state.memberships).not.toHaveBeenCalled();
    expect(state.location).not.toHaveBeenCalled();
  });

  it("keeps the More badges and café isolation without a second membership query", async () => {
    mockBadgeQueries();
    const inputs = await getMoreBadgeInputs("owner-1");
    const badges = buildMoreBadges(inputs);
    expect(inputs.currency).toBe("EUR");
    expect(badges).toMatchObject({
      hoursNotSet: true, uploadsNeedingReview: 1,
      firstUploadToReview: "upload-review", missingFeeDays: 0,
      rentMissing: true, alerts: 3,
    });
    expect(inputs.toast).toBeUndefined(); // Staff must not read owner-only Toast credentials.
    expect(state.active).toHaveBeenCalledWith("owner-1");
    expect(state.memberships).toHaveBeenCalledWith("owner-1");
    expect(state.from).not.toHaveBeenCalledWith("memberships");
  });

  it("does not query badges for a selected demo or an inaccessible café", async () => {
    mockBadgeQueries();
    state.active.mockResolvedValueOnce("demo").mockResolvedValueOnce("unrelated-cafe");
    expect(await getMoreBadgeInputs("owner-1")).toEqual({});
    expect(await getMoreBadgeInputs("owner-1")).toEqual({});
    expect(state.from).not.toHaveBeenCalled();
    expect(state.uploads).not.toHaveBeenCalled();
  });
});
