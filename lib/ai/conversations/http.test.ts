import { describe, expect, it, vi } from "vitest";

vi.mock("./auth.server", () => ({
  ConversationApiError: class ConversationApiError extends Error {
    constructor(public status: number, public code: string) { super(code); }
  },
}));

import { conversationError, readBoundedJson, requireSameOrigin } from "./http.server";

const endpoint = "https://cafe.example/api/ai/threads";
const sameOrigin = "https://cafe.example";

function post(body: string, headers?: Record<string, string>) {
  return new Request(endpoint, {
    method: "POST",
    headers: { origin: sameOrigin, "content-type": "application/json", ...headers },
    body,
  });
}

describe("Supervisor conversation HTTP boundary", () => {
  it("rejects missing and cross-origin cookie-authenticated writes", () => {
    expect(() => requireSameOrigin(post("{}", { origin: "https://evil.example" }))).toThrow();
    expect(() => requireSameOrigin(new Request(endpoint))).toThrow();
    expect(() => requireSameOrigin(post("{}"))).not.toThrow();
  });

  it("parses a correctly bounded JSON body", async () => {
    expect(await readBoundedJson(post('{"requestId":"abc"}'))).toEqual({ requestId: "abc" });
  });

  it("rejects non-JSON inputs and malformed JSON", async () => {
    await expect(readBoundedJson(post("hi", { "content-type": "text/plain" }))).rejects.toThrow();
    await expect(readBoundedJson(post("{oops"))).rejects.toThrow();
  });

  it("rejects request bodies larger than eight kilobytes", async () => {
    await expect(readBoundedJson(post(JSON.stringify({ text: "x".repeat(9000) })))).rejects.toThrow();
  });

  it("returns generic errors without leaking prompts, SQL, or tokens", async () => {
    const response = conversationError(new Error("sensitive supplier invoice: $500"));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ error: "conversation_request_failed" });
  });

  it("reports missing unapplied database tables as unavailable", async () => {
    const response = conversationError({ code: "42P01", message: "private table name" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "conversation_storage_unavailable" });
  });
});
