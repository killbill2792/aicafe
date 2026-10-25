import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, href, ...props }: {children:import("react").ReactNode;href:string}) =>
    createElement("a", {href,...props}, children),
}));
vi.mock("@/components/shared/PeriodSwitch", () => ({
  default: ({current}:{current:string})=>createElement("div",{role:"group"},current+" · Week · Month"),
}));
vi.mock("@/components/operations/agentVisuals", () => ({
  AgentAvatar:()=>createElement("span",null,"avatar"),
}));
import SupervisorChatComposer, { type SupervisorChatCopy } from "./SupervisorChatComposer";
import type { ChatStartCopy, ChatStartData } from "./ChatStart";

const copy = {
  askAnything: "Ask anything", composerLabel: "Supervisor conversation",
  addAttachment: "Attach file", voiceInput: "Dictate", sendMessage: "Send",
  suggestions: ["How are we doing today?", "What needs my attention?", "Any staff issues?", "Try a drink price experiment"],
  threads: "History", newThread: "New chat", empty: "No chats yet",
  emptyHeading: "What can I help with today?", emptyIntro: "Ask about your café.",
  historyTitle: "Chat history", startNewChat: "New chat", closeHistory: "Close history",
  unavailable: "Chat unavailable", source: "Source", supervisor: "Supervisor",
  sending: "Checking your café...", taskOpen: "Open", voiceStop: "Stop dictation",
  voiceNoSpeech:"No speech",voiceUnavailable:"Voice unsupported",
  voiceServiceUnavailable:"Voice temporarily unavailable",voiceNetworkError:"Voice network error",
  voiceTooLong:"Recording too long",voiceError:"Voice failed",voicePermissionDenied:"Mic blocked",
  voiceReview:"Review transcript",voiceCanceled:"Canceled",voiceProcessing:"Transcribing",
} as SupervisorChatCopy;

const chatStartData:ChatStartData = {
  period:"today",sales:"$300",costs:"$225",kept:"$75",
  attention:[],partial:false,estimated:false,incomplete:false,
  shareCaption:"25% of sales",comparisonCaption:"17% more than last period",
};
const chatStartCopy:Omit<ChatStartCopy,"suggestions"> = {
  keyNumbers:"Key numbers",sales:"Sales",knownCosts:"Known costs",youKeep:"You keep",
  partial:"Partial",estimate:"Estimated",incomplete:"Costs incomplete",
  details:"Details",seeAll:"See all (0)",allGood:"All good",
  summary:"Today: Sales $300 · You keep $75 · Nothing needs you",
  roles:{alex:"Pricing",leo:"Money",maya:"Supplies",olivia:"Staff"},
  experimentPrompt:"I want to try a price experiment",
  suggestionsLabel:"Starter questions",handledLabel:"See handled",
};
function startHtml(enabled=true) {
  return renderToStaticMarkup(createElement(SupervisorChatComposer,{
    enabled,unavailableReason:null,locale:"en",copy,chatStartData,chatStartCopy,
  }));
}

describe("modern Supervisor conversation shell", () => {
  it("shows one compact numbers section, four team cards and all four tappable starter chips",()=>{
    const html=startHtml();
    expect(html).toContain('aria-label="Key numbers"');
    for(const text of ["$300","$225","$75","25% of sales","17% more than last period",
      "Alex","Leo","Maya","Olivia","How are we doing today?","What needs my attention?",
      "Any staff issues?","Try a drink price experiment"])
      expect(html).toContain(text);
    expect(html.match(/data-agent-id=/g)).toHaveLength(4);
    expect(html.match(/min-h-12 w-max shrink-0/g)).toHaveLength(4);
    expect(html).toContain('href="/operations?status=handled"');
    expect(html).not.toContain("What can I help with today?");
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-label="Chat history"');
    expect(html).toContain('aria-label="New chat"');
    expect(html).toContain("<textarea");
    expect(html).toContain('aria-label="Dictate"');
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain("SUPERVISOR_CHAT_ENABLED");
    expect(html).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
  it("does not render a second Home snapshot or standalone experiment control",()=>{
    const html=startHtml();
    expect(html.match(/aria-label="Key numbers"/g)).toHaveLength(1);
    expect(html).not.toContain("Today snapshot");
    expect(html).not.toContain("No sales recorded yet");
    expect(html).not.toContain("What can I help with today?");
    expect(html).toContain('aria-label="Dictate"');
    expect(readFileSync("components/home/SupervisorChatComposer.tsx","utf8"))
      .not.toContain("{enabled&&threadId&&experimentCopy&&<SupervisorExperiment");
  });
  it("explains unavailable chat while keeping its four starters disabled",()=>{
    const html=startHtml(false);
    expect(html).toContain('role="status"');
    expect(html).toContain("Chat unavailable");
    expect((html.match(/disabled=""/g)||[]).length).toBeGreaterThanOrEqual(4);
  });
  it("captures bounded audio with MediaRecorder, transcribes privately, never auto-sends",()=>{
    const source=readFileSync("components/home/SupervisorChatComposer.tsx","utf8");
    const handler=source.slice(source.indexOf("async function transcribeAudio"),source.indexOf("function stopRecording"));
    expect(source).toContain("new MediaRecorder(");
    expect(source).toContain('fetch("/api/ai/transcribe"');
    expect(source).toContain("recordingLimit.current = setTimeout");
    expect(source).toContain("parseTranscriptionResponse");
    expect(source).toContain("voiceMessageForError");
    expect(source).toContain("audioExtensionForMime");
    expect(source).not.toContain('||"audio/mp4"');
    expect(source).not.toContain("SpeechRecognition");
    expect(source).not.toContain("webkitSpeechRecognition");
    expect(handler).toContain("setDraft(");
    expect(handler).not.toContain("sendText(");
    expect(source).toContain("onSubmit={(event)");
    expect(source).toContain("copy.transcribing");
  });
  it("retries a durable unanswered owner turn with its original idempotency key",()=>{
    const source=readFileSync("components/home/SupervisorChatComposer.tsx","utf8");
    expect(source).toContain('message.role === "owner"');
    expect(source).toContain("answeredOwnerIds");
    expect(source).toContain("pendingOwnerIds.has(message.id)");
    expect(source).toContain('sendText(message.text ?? "", message.clientMessageId ?? undefined)');
    expect(source).toContain("sendKey(existingKey, retryId.current, () => crypto.randomUUID())");
  });
  it("keeps the chat-start summary outside the independently scrolling transcript",()=>{
    const source=readFileSync("components/home/SupervisorChatComposer.tsx","utf8");
    expect(source).toContain("100dvh");
    expect(source).toContain('className="flex min-h-full flex-col items-stretch justify-start gap-4"');
    expect(source).toContain("overflow-y-auto overscroll-contain");
    expect(source).toContain("mt-auto shrink-0 border-t");
    expect(source).toContain("transcriptScrollTarget({");
    expect(source).toContain("prependAnchor.current");
    expect(source).toContain("openingThread.current");
    expect(source).toContain("hasChatMessages&&<div");
    expect(source).toContain("setStartExpanded(v=>!v)");
    expect(source).not.toContain("responsiveTailSpace");
    expect(source).not.toContain("tailSpacer");
    expect(source).toContain('href="/operations"');
    expect(source).toContain("rows={1}");
  });
  it("shows café identity only in the desktop sidebar and keeps language in its footer",()=>{
    const layout=readFileSync("app/[locale]/layout.tsx","utf8");
    const nav=readFileSync("components/SideNav.tsx","utf8");
    const home=readFileSync("app/[locale]/page.tsx","utf8");
    const chat=readFileSync("components/home/SupervisorChatComposer.tsx","utf8");
    expect(layout).toContain("getActiveCafeName()");
    expect(layout).toContain('languageSwitch={<LanguageSwitch href="/" compact />}');
    expect(layout).toContain("<SideNav cafeName={activeCafeName}");
    expect(nav).toContain("{cafeName}");
    expect(nav).toContain('className="mt-auto border-t');
    expect(nav).toContain("{languageSwitch}");
    expect(home).not.toContain("{snapshot.business.name}");
    expect(home).toContain("languageSwitch={<LanguageSwitch");
    expect(chat).toContain("md:hidden");
    expect(chat).toContain("{languageSwitch}");
    expect(home).not.toContain('<header className="flex items-center justify-between gap-3 px-1">');
  });
});
