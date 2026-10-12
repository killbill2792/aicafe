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
  it("renders an accessible compact empty state and responsive editable composer", () => {
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
  it("renders actual precomputed Today and persisted Team previews inside the empty chat", () => {
    const html = renderToStaticMarkup(createElement(SupervisorChatComposer, {
      enabled: true, unavailableReason: null, locale: "en", copy,
      snapshot: { title: "Today", hasSales: false, caption: "No sales data yet",
        stats: [{ label: "Sales", value: "No sales recorded yet" }], seeAll: "See all",
        sections: [{ title: "Needs you", empty: "No pending tasks", href: "/operations?status=needs_you",
          items: [], count: 0 }],
      },
    }));
    expect(html).toContain("No sales recorded yet");
    expect(html).toContain("Needs you");
    expect(html).toContain("Today");
    expect(html).not.toContain("See all");
    expect(html).toContain('aria-label="Dictate"');
    expect(html).not.toContain("Listening… review the transcript before sending");
  });
  it("captures bounded audio with MediaRecorder, transcribes in a private endpoint, and never sends automatically", () => {
    const source = readFileSync("components/home/SupervisorChatComposer.tsx", "utf8");
    const handler = source.slice(source.indexOf("async function transcribeAudio"), source.indexOf("function stopRecording"));
    expect(source).toContain("new MediaRecorder(");
    expect(source).toContain('fetch("/api/ai/transcribe"');
    expect(source).toContain("recordingLimit.current = setTimeout");
    expect(source).not.toContain("SpeechRecognition");
    expect(source).not.toContain("webkitSpeechRecognition");
    expect(handler).toContain("setDraft(");
    expect(handler).not.toContain("sendText(");
    expect(source).toContain("onSubmit={(event)");
    expect(source).toContain('bg-red-600');
    expect(source).toContain("copy.transcribing");
  });
  it("places retry under a durable unanswered owner bubble with its existing clientMessageId", () => {
    const source = readFileSync("components/home/SupervisorChatComposer.tsx", "utf8");
    expect(source).toContain('message.role === "owner"');
    expect(source).toContain("answeredOwnerIds");
    expect(source).toContain("pendingOwnerIds.has(message.id)");
    expect(source).toContain('sendText(message.text ?? "", message.clientMessageId ?? undefined)');
    expect(source).toContain("const clientMessageId = existingKey ?? retryId.current ?? crypto.randomUUID()");
  });

  it("is a single viewport-filling chat, optimistic owner-anchor, and no forced bottom scroll",()=>{
    const source = readFileSync("components/home/SupervisorChatComposer.tsx","utf8");
    const wrapper = readFileSync("components/home/SupervisorHomePanel.tsx","utf8");
    expect(wrapper).not.toContain("rounded-[28px]");
    expect(source).toContain("100dvh");
    expect(source).not.toContain("790px");
    expect(source).toContain("setOptimisticOwner({id:");
    expect(source).toContain("data-client-message-id");
    expect(source).toContain("getBoundingClientRect().top");
    expect(source).toContain("ownerManuallyScrolled.current");
    expect(source).toContain("previousScrollHeight.current");
    expect(source).not.toContain('node.scrollTo({ top: node.scrollHeight');
    expect(source).toContain('href="/operations"');
    expect(source).toContain("rows={1}");
  });
  it("uses business profile identity in desktop navigation",()=>{
    const layout=readFileSync("app/[locale]/layout.tsx","utf8");
    const nav=readFileSync("components/SideNav.tsx","utf8");
    expect(layout).toContain("getCafeProfile()");
    expect(layout).toContain("cafeName={cafeProfile.name}");
    expect(nav).toContain("{cafeName}");
    expect(nav).not.toContain('tLayout("title")');
  });
});
