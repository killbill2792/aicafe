import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  supabase: true,
  scope: { businessId: "cafe-1", ownerUserId: "owner-1" },
  denied: false,
  sessionError: false,
  writerError: false,
  sessionQueries: [] as string[],
  writerQueries: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/client", () => ({
  isSupabaseConfigured: () => mock.supabase,
}));
class Forbidden extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
vi.mock("./auth.server", () => ({
  ConversationApiError: Forbidden,
  authenticatedConversationContext: async () => {
    if (mock.denied) throw new Forbidden(403, "owner_access_required");
    return { scope: mock.scope };
  },
}));
function query(kind: "session" | "writer") {
  return {
    from(table: string) {
      (kind === "session" ? mock.sessionQueries : mock.writerQueries).push(table);
      return {
        select() { return this; },
        eq() { return this; },
        async limit() {
          return { error: (kind === "session" ? mock.sessionError : mock.writerError) ?
            { code: "PGRST205" } : null };
        },
      };
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({
  createServerSupabaseClient: async () => query("session"),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminSupabaseClient: () => query("writer"),
}));

import { getSupervisorChatReadiness, isSupervisorChatConfigured } from "./enabled.server";

beforeEach(() => {
  mock.supabase = true;
  mock.denied = false;
  mock.sessionError = false;
  mock.writerError = false;
  mock.sessionQueries = [];
  mock.writerQueries = [];
  delete process.env.SUPERVISOR_CHAT_ENABLED;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-server-key";
});
afterEach(() => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPERVISOR_CHAT_ENABLED;
});

describe("owner-scoped Supervisor server activation preflight", () => {
  it("enables live chat when installed backend + RLS + secure writer work, with no feature flag", async () => {
    expect(isSupervisorChatConfigured()).toBe(true);
    expect(await getSupervisorChatReadiness(true)).toEqual({ enabled: true, reason: null });
    expect(mock.sessionQueries).toEqual(["ai_threads"]);
    expect(mock.writerQueries).toEqual(["ai_messages"]);
  });

  it("does not allow owner-only chat for a manager or signed-out visitor", async () => {
    expect(await getSupervisorChatReadiness(false)).toEqual({
      enabled: false, reason: "owner_access_required",
    });
    mock.denied = true;
    expect(await getSupervisorChatReadiness(true)).toEqual({
      enabled: false, reason: "owner_access_required",
    });
    expect(mock.writerQueries).toHaveLength(0);
  });

  it("does not enable a deployed app without working storage access", async () => {
    mock.sessionError = true;
    expect(await getSupervisorChatReadiness(true)).toEqual({
      enabled: false, reason: "storage_unavailable",
    });
    mock.sessionError = false;
    mock.writerError = true;
    expect(await getSupervisorChatReadiness(true)).toEqual({
      enabled: false, reason: "storage_unavailable",
    });
  });

  it("preserves explicit off switch for both the UI and the POST guard", async () => {
    process.env.SUPERVISOR_CHAT_ENABLED = "false";
    expect(isSupervisorChatConfigured()).toBe(false);
    expect(await getSupervisorChatReadiness(true)).toEqual({
      enabled: false, reason: "explicitly_disabled",
    });
    expect(mock.sessionQueries).toHaveLength(0);
  });

  it("reports missing writer key before any privileged query is attempted", async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(isSupervisorChatConfigured()).toBe(false);
    expect(await getSupervisorChatReadiness(true)).toEqual({
      enabled: false, reason: "server_writer_unconfigured",
    });
    expect(mock.writerQueries).toHaveLength(0);
  });
});
