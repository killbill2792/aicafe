import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children }: { children: unknown }) => children,
}));
import SupervisorChatComposer, { type SupervisorChatCopy } from "./SupervisorChatComposer";

const copy = {
  askAnything: "Ask anything", composerLabel: "Supervisor conversation",
  addAttachment: "Attach file", voiceInput: "Dictate", sendMessage: "Send",
  suggestions: ["How many orders did we receive today?", "What are my monthly bills?"],
  threads: "History", newThread: "New chat", empty: "No chats yet",
  emptyHeading: "What can I help with today?", emptyIntro: "Ask about your café.",
  historyTitle: "Chat history", startNewChat: "New chat", closeHistory: "Close history",
  unavailable: "Chat unavailable", source: "Source", supervisor: "Supervisor",
  sending: "Checking your café...", taskOpen: "Open", voiceStop: "Stop dictation",
} as SupervisorChatCopy;

describe("modern Supervisor conversation shell", () => {
  it("renders an accessible rich empty state and large sticky editable composer", () => {
    const html = renderToStaticMarkup(createElement(SupervisorChatComposer, {
      enabled: true, unavailableReason: null, locale: "en", copy,
    }));
    expect(html).toContain("What can I help with today?");
    expect(html).toContain("How many orders did we receive today?");
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-label="Chat history"');
    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain("<textarea");
    expect(html).toContain('aria-label="Dictate"');
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain("SUPERVISOR_CHAT_ENABLED");
    expect(html).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
  it("never lets a browser speech callback submit dictated content", () => {
    const source = readFileSync("components/home/SupervisorChatComposer.tsx", "utf8");
    const handler = source.slice(source.indexOf("recognition.onresult = "), source.indexOf("recognition.onerror = "));
    expect(handler).toContain("setDraft(");
    expect(handler).not.toContain("sendText(");
    expect(handler).not.toContain("fetch(");
    expect(source).toContain("onSubmit={(event)");
    expect(source).toContain("dictation === \"listening\"");
    expect(source).toContain("copy.voiceStop");
  });
});
