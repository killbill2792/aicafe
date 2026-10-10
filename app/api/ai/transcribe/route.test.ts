import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ denied: false, calls: 0 }));
vi.mock("@/lib/ai/conversations/auth.server", () => ({
  ConversationApiError: class ConversationApiError extends Error {
    constructor(public status: number, public code: string) { super(code); }
  },
  authenticatedConversationContext: async () => {
    if (settings.denied) throw new Error("owner required");
    return { scope: { ownerUserId: "test-owner", businessId: "test-cafe" } };
  },
}));
import { POST } from "./route";

function audioRequest(origin = "https://cafe.example") {
  const body = new FormData();
  body.append("audio", new File(["test audio content"], "dictation.webm", { type: "audio/webm" }));
  body.append("durationSeconds", "4");
  return new Request("https://cafe.example/api/ai/transcribe", {
    method: "POST", headers: { origin }, body,
  });
}

beforeEach(() => {
  settings.denied = false; settings.calls = 0;
  process.env.OPENAI_API_KEY = "test-server-key";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    settings.calls++;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init.body as FormData).get("model")).toBe("gpt-transcribe");
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
    expect(init.headers).toEqual({ authorization: "Bearer test-server-key" });
    return new Response(JSON.stringify({ text: " How much did we make today? " }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.OPENAI_API_KEY; });

describe("private bounded Supervisor dictation", () => {
  it("authenticates owner and returns editable transcript without retaining audio", async () => {
    const response = await POST(audioRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "How much did we make today?" });
    expect(settings.calls).toBe(1);
  });
  it("rejects cross-origin uploads before sending audio to OpenAI", async () => {
    const response = await POST(audioRequest("https://other.example"));
    expect(response.status).toBe(403);
    expect(settings.calls).toBe(0);
  });
  it("denies missing owner access without provider requests", async () => {
    settings.denied = true;
    const response = await POST(audioRequest());
    expect(response.status).toBe(500);
    expect(settings.calls).toBe(0);
  });
  it("refuses a stated upload too large before parsing its body", async () => {
    const request = audioRequest();
    request.headers.set("content-length", String(9 * 1024 * 1024));
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(settings.calls).toBe(0);
  });
});
