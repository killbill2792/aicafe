"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Clock3, History, Mic, Plus, Send, Coffee, Sparkles, Square, X, AlertCircle, Paperclip, LoaderCircle, ChevronDown, UsersRound } from "lucide-react";
import { AgentAvatar, agentVisuals } from "@/components/operations/AITeamCard";
import type { HomeTaskPreviewItem } from "@/components/home/HomeTaskSections";
import { Link } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import { nextDictationStage } from "@/lib/ai/conversations/dictationState";
import type { StoredAttachment } from "@/lib/ai/conversations/attachments";
import type { SupervisorChatUnavailableReason } from "@/lib/ai/conversations/readiness";
import type { ConversationMessage, ConversationPage, ConversationThread } from "@/lib/ai/conversations/contracts";
import { beginOptimisticOwner, sendKey, visibleConversationMessages,
  transcriptScrollTarget, responsiveTailSpace } from "./supervisorChatBehavior";

export type SupervisorChatCopy = {
  askAnything: string; composerLabel: string; addAttachment: string; voiceInput: string; sendMessage: string; teamButton: string;
  comingSoon: string; suggestions: string[];
  live: string; threads: string; newThread: string; empty: string; loading: string; sending: string;
  retry: string; unavailable: string; more: string; you: string; supervisor: string; source: string; sourceCafe: string; sourcePricing: string; sourceTasks: string; sourceRules: string; sourceVerified: string;
  listening: string; voiceReview: string; voiceUnavailable: string; voiceStop: string;
  voiceProcessing: string; voicePermissionDenied: string; voiceNoSpeech: string;
  voiceError: string; voiceCanceled: string;
  attachmentSaved: string; attachmentNotice: string; attachmentUpload: string;
  statusDisabled: string; statusDatabase: string; statusWriter: string; statusOwner: string; statusStorage: string;
  emptyHeading: string; emptyIntro: string; historyTitle: string; closeHistory: string;
  startNewChat: string; reviewHint: string; taskOpen: string;
  needsYou: string; handled: string; watching: string;
  usageHeading: string; usageRequests: string; usageTokens: string;
  usageEstimate: string; usageCostUnknown: string;
  answerFailed: string; retryAnswer: string; todaySummary: string;
  snapshotExpand: string; snapshotCollapse: string; recording: string; transcribing: string;
};
type Locale = "en" | "es" | "ar";
export type SupervisorHomeSnapshot = {
  title: string; stats: { label: string; value: string }[];
  caption: string | null; hasSales: boolean;
  sections: { title: string; empty: string; href: string;
    items: HomeTaskPreviewItem[]; count: number }[];
  seeAll: string;
};
type MessageResponse = { message: ConversationMessage; reply: ConversationMessage; replyStatus: "complete" };
async function jsonFrom<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error("conversation_request_failed");
  return response.json() as Promise<T>;
}
async function loadMessages(id: string, offset = 0): Promise<ConversationPage<ConversationMessage>> {
  return jsonFrom<ConversationPage<ConversationMessage>>(await fetch(
    "/api/ai/threads/" + encodeURIComponent(id) + "/messages?offset=" + offset,
    { credentials: "same-origin", cache: "no-store" },
  ));
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function ReplyBlock({ block, copy, locale }: { block: unknown; copy: SupervisorChatCopy; locale: Locale }) {
  if (!record(block)) return null;
  if ((block.type === "text" || block.type === "warning") && typeof block.text === "string") {
    return block.type === "warning"
      ? <p className="flex gap-2 rounded-2xl border border-[#F2D59F] bg-[#FFF3DD] p-3 text-[17px] leading-relaxed text-ink">
          <AlertCircle aria-hidden="true" size={20} className="mt-1 shrink-0 text-[#A96510]" />{block.text}
        </p>
      : <p className="whitespace-pre-wrap break-words text-[17px] leading-relaxed text-ink">{block.text}</p>;
  }
  if ((block.type === "metric" || block.type === "count") && typeof block.label === "string" &&
    typeof (block.type === "metric" ? block.valueCents : block.value) === "number") {
    const number = block.type === "metric" ? block.valueCents as number : block.value as number;
    if (!Number.isSafeInteger(number)) return null;
    const source = record(block.source) ? block.source : null;
    return <div className="w-fit max-w-full rounded-xl bg-[#F2F8F3] px-3 py-2">
      <p className="text-[15px] font-semibold text-ink-muted">{block.label}</p>
      <p className="font-headline text-2xl font-extrabold tracking-tight text-ink">
        {block.type === "metric" ? formatCents(number) : new Intl.NumberFormat(locale).format(number)}
      </p>
      {source && <p className="mt-2 text-[13px] text-ink-muted">
        {copy.source}: {source.source === "cafe_state" ? copy.sourceCafe : source.source === "pricing_engine" ? copy.sourcePricing : source.source === "operating_tasks" ? copy.sourceTasks : source.source === "owner_rules" ? copy.sourceRules : copy.sourceVerified} · {String(source.asOf ?? "")}
      </p>}
    </div>;
  }
  if (block.type === "task_card" && typeof block.title === "string" && typeof block.agent === "string" &&
    typeof block.status === "string" && typeof block.href === "string" &&
    block.href.startsWith("/operations") && !block.href.startsWith("//")) {
    const statusText = block.status === "handled" ? copy.handled :
      block.status === "watching" ? copy.watching : copy.needsYou;
    return <Link href={block.href} className="block rounded-2xl border border-[#D8C8B5] bg-white p-4 no-underline shadow-sm transition-colors hover:bg-[#FFF8EF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[13px] font-extrabold uppercase tracking-wide text-ink-muted">{block.agent}</span>
          <p className="mt-1 break-words text-[17px] font-bold text-ink">{block.title}</p>
          <span className="mt-2 inline-flex rounded-full bg-[#F0E5D8] px-3 py-1 text-sm font-semibold text-ink">{statusText}</span>
        </div>
        <span className="shrink-0 text-[15px] font-bold text-good">{copy.taskOpen} ↗</span>
      </div>
    </Link>;
  }
  return null;
}

function SupervisorMessage({ message, copy, locale }: {
  message: ConversationMessage; copy: SupervisorChatCopy; locale: Locale;
}) {
  if (message.role === "owner") return <article className="ms-auto max-w-[88%] rounded-[22px] rounded-ee-md bg-[#EADFCC] px-4 py-3 text-[17px] text-ink shadow-sm">
    <p className="whitespace-pre-wrap break-words">{message.text}</p>
  </article>;
  return <article className="max-w-[94%] space-y-3">
    <div className="flex items-center gap-2 text-[15px] font-bold text-ink-muted">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#E7EFE5] text-good">
        <Sparkles size={17} aria-hidden="true" />
      </span>
      {copy.supervisor}
    </div>
    <div className="space-y-3 ps-1">
      {(message.blocks ?? []).map((block, i) =>
        <ReplyBlock key={i} block={block} copy={copy} locale={locale} />)}
    </div>
  </article>;
}

function HomeSnapshot({ snapshot }: { snapshot: SupervisorHomeSnapshot }) {
  return <div className="w-full space-y-4 text-start">
    <section aria-label={snapshot.title}>
      <h3 className="mb-2 text-xs font-extrabold uppercase tracking-wider text-ink-muted">{snapshot.title}</h3>
      <div className="grid grid-cols-2 gap-2">
        {snapshot.stats.map((stat) => <div key={stat.label}
          className="rounded-2xl border border-[#E2D3BF] bg-white p-3 shadow-sm">
          <p className="text-[13px] font-semibold text-ink-muted">{stat.label}</p>
          <p className="mt-1 break-words text-xl font-extrabold text-ink">{stat.value}</p>
        </div>)}
      </div>
      {snapshot.caption && <p className="mt-2 text-sm text-ink-muted">{snapshot.caption}</p>}
    </section>
    {snapshot.sections.map((section) => <section key={section.href}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-extrabold uppercase tracking-wide text-ink-muted">
          {section.title} <span className="text-ink">{section.count}</span>
        </h3>
        <Link href={section.href} className="text-sm font-bold text-good underline">{snapshot.seeAll}</Link>
      </div>
      {section.items.length ? <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {section.items.map((task) => <Link key={task.id} href={task.href}
          className="flex min-h-16 items-center gap-2 rounded-2xl border border-[#E2D3BF] bg-white p-3 text-ink no-underline hover:bg-[#FFF7EC]">
          <AgentAvatar agentId={task.agentId} size="task" />
          <span className="min-w-0 flex-1">
            <span className={`block text-sm font-bold ${agentVisuals[task.agentId].accent}`}>{task.agentName}</span>
            <span className="block text-[15px] font-semibold">{task.title}</span>
          </span>
        </Link>)}
      </div> : <p className="mt-1 text-sm text-ink-muted">{section.empty}</p>}
    </section>)}
  </div>;
}

export default function SupervisorChatComposer({
  enabled, locale, copy, snapshot, onActivityChange,
}: {
  enabled: boolean; unavailableReason: SupervisorChatUnavailableReason | null;
  locale: Locale; copy: SupervisorChatCopy; snapshot?: SupervisorHomeSnapshot;
  onActivityChange?: (active: boolean) => void;
}) {
  const [threads, setThreads] = useState<ConversationThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [optimisticOwner, setOptimisticOwner] = useState<{ id: string; text: string; clientMessageId: string } | null>(null);
  const [recentTurnId, setRecentTurnId] = useState<string | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [snapshotExpanded, setSnapshotExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [usage, setUsage] = useState<{
    requests: number; inputTokens: number; outputTokens: number;
    estimatedCostMicros: number | null;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [threadTitle, setThreadTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [dictation, dispatchDictation] = useReducer(nextDictationStage, "idle");
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<StoredAttachment[]>([]);
  const [mediaNotice, setMediaNotice] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const recordingStream = useRef<MediaStream | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const recordingStartedAt = useRef(0);
  const recordingGeneration = useRef(0);
  const requestingMicrophone = useRef(false);
  const recordingLimit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const transcript = useRef<HTMLDivElement | null>(null);
  const tailSpacer = useRef<HTMLDivElement | null>(null);
  const previousScrollHeight = useRef<number | null>(null);
  const scrollNewestOnOpen = useRef(true);
  const focusTurnId = useRef<string | null>(null);
  const ownerManuallyScrolled = useRef(false);
  const retryId = useRef<string | null>(null);
  const threadRequestId = useRef<string | null>(null);

  function cleanupRecording() {
    recordingGeneration.current++;
    requestingMicrophone.current = false;
    const active = recorder.current;
    recorder.current = null;
    if (active) {
      active.ondataavailable = null; active.onstop = null; active.onerror = null;
      if (active.state !== "inactive") { try { active.stop(); } catch { /* recording already ended */ } }
    }
    recordingStream.current?.getTracks().forEach((track) => track.stop());
    recordingStream.current = null;
    audioChunks.current = [];
    if (recordingLimit.current) clearTimeout(recordingLimit.current);
    recordingLimit.current = null;
  }
  useEffect(() => () => {
    recordingGeneration.current++;
    const active = recorder.current;
    if (active) {
      active.onstop = null;
      if (active.state !== "inactive") active.stop();
    }
    recordingStream.current?.getTracks().forEach((track) => track.stop());
    if (recordingLimit.current) clearTimeout(recordingLimit.current);
  }, []);
  useEffect(() => {
    if (!enabled) {
      recordingGeneration.current++;
      const active = recorder.current;
      if (active) {
        active.onstop = null;
        if (active.state !== "inactive") active.stop();
      }
      recordingStream.current?.getTracks().forEach((track) => track.stop());
      recorder.current = null;
      recordingStream.current = null;
      audioChunks.current = [];
      dispatchDictation({ type: "reset" });
    }
  }, [enabled]);
  useEffect(() => {
    if (dictation !== "listening") return;
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - recordingStartedAt.current) / 1000)), 250);
    return () => clearInterval(interval);
  }, [dictation]);
  useEffect(() => { onActivityChange?.(messages.length > 0 || sending); }, [messages.length, sending, onActivityChange]);
  useLayoutEffect(() => {
    const node = composer.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = Math.min(node.scrollHeight, 160) + "px";
  }, [draft]);
  useEffect(() => {
    if (!historyOpen || !enabled) return;
    const controller = new AbortController();
    void fetch("/api/ai/usage", { signal: controller.signal, cache: "no-store" })
      .then((res) => jsonFrom<{ requests: number; inputTokens: number;
        outputTokens: number; estimatedCostMicros: number | null }>(res))
      .then((data) => { if (!controller.signal.aborted) setUsage(data); })
      .catch(() => { if (!controller.signal.aborted) setUsage(null); });
    return () => controller.abort();
  }, [enabled, historyOpen]);
  useEffect(() => {
    if (!historyOpen) return;
    const keydown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [historyOpen]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetch("/api/ai/threads", { signal: controller.signal, cache: "no-store" })
      .then((res) => jsonFrom<ConversationPage<ConversationThread>>(res))
      .then((page) => { if (!controller.signal.aborted) { setThreads(page.items); if (page.items.length) setThreadId((current) => current ?? page.items[0].id); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [enabled]);
  useEffect(() => {
    if (!enabled || !threadId || sending) return;
    const controller = new AbortController();
    void fetch("/api/ai/threads/" + encodeURIComponent(threadId) + "/messages?offset=0",
      { signal: controller.signal, cache: "no-store" })
      .then((res) => jsonFrom<ConversationPage<ConversationMessage>>(res))
      .then((page) => {
        if (controller.signal.aborted) return;
        setMessages(page.items); setNextOffset(page.nextOffset);
        setThreadTitle(threads.find((thread) => thread.id === threadId)?.title ?? null);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [enabled, threadId, sending, threads]);
  useEffect(() => {
    if (!enabled || !threadId) return;
    const controller = new AbortController();
    void fetch("/api/ai/threads/" + encodeURIComponent(threadId) + "/attachments",
      { signal: controller.signal, cache: "no-store" })
      .then((res) => jsonFrom<{ items: StoredAttachment[] }>(res))
      .then((page) => { if (!controller.signal.aborted) setAttachments(page.items); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [enabled, threadId]);
  // Scroll only for an initial history load or a new owner turn, not on every reply.
  // Tail space is calculated from the transcript viewport and collapses after
  // response completion, instead of leaving a permanent blank 40dvh block.
  useLayoutEffect(() => {
    const node = transcript.current;
    if (!node) return;
    if (previousScrollHeight.current !== null) {
      node.scrollTop = transcriptScrollTarget({
        scrollTop: node.scrollTop, scrollHeight: node.scrollHeight,
        previousScrollHeight: previousScrollHeight.current,
        anchorDelta: null, userScrolled: false, openNewest: false,
      }) ?? node.scrollTop;
      previousScrollHeight.current = null;
      return;
    }
    const anchor = focusTurnId.current ? Array.from(node.querySelectorAll<HTMLElement>("[data-client-message-id]"))
      .find(el => el.dataset.clientMessageId === focusTurnId.current) : null;
    const rect = node.getBoundingClientRect();
    const anchorDelta = anchor ? anchor.getBoundingClientRect().top - rect.top : null;
    const spacer = tailSpacer.current;
    if (spacer) {
      const anchorOffset = anchorDelta === null ? 0 : node.scrollTop + anchorDelta;
      const below = node.scrollHeight - spacer.offsetHeight - anchorOffset;
      spacer.style.height = anchor
        ? responsiveTailSpace(node.clientHeight, below, sending) + "px" : "0px";
    }
    const target = transcriptScrollTarget({
      scrollTop: node.scrollTop, scrollHeight: node.scrollHeight,
      previousScrollHeight: null, anchorDelta,
      userScrolled: ownerManuallyScrolled.current,
      openNewest: scrollNewestOnOpen.current,
    });
    if (target !== null) node.scrollTop = target;
    if (anchorDelta !== null && !ownerManuallyScrolled.current) scrollNewestOnOpen.current = false;
    else if (scrollNewestOnOpen.current && messages.length) scrollNewestOnOpen.current = false;
  }, [messages, optimisticOwner, sending]);

  async function refreshThreads() {
    const page = await jsonFrom<ConversationPage<ConversationThread>>(
      await fetch("/api/ai/threads", { cache: "no-store" }));
    setThreads(page.items);
    if (threadId) setThreadTitle(page.items.find((thread) => thread.id === threadId)?.title ?? null);
  }
  async function ensureThread(): Promise<string> {
    if (threadId) return threadId;
    threadRequestId.current ??= crypto.randomUUID();
    const created = await jsonFrom<{ thread: ConversationThread }>(await fetch("/api/ai/threads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: threadRequestId.current }),
    }));
    setThreadId(created.thread.id); setThreadTitle(created.thread.title);
    threadRequestId.current = null;
    return created.thread.id;
  }
  async function sendText(value: string, existingKey?: string) {
    const text = value.trim();
    if (!enabled || !text || sending || uploading || recorder.current || dictation === "recognizing" || text.length > 4000) return;
    const clientMessageId = sendKey(existingKey, retryId.current, () => crypto.randomUUID());
    retryId.current = clientMessageId;
    if (!existingKey) {
      // Optimistic view only: the server owns persistence and idempotency.
      setOptimisticOwner(beginOptimisticOwner(text, clientMessageId));
      setRecentTurnId(clientMessageId);
      focusTurnId.current = clientMessageId;
      ownerManuallyScrolled.current = false;
      scrollNewestOnOpen.current = false;
      setDraft("");
    }
    setSending(true); setError(false);
    let attemptedThreadId: string | null = null;
    try {
      const id = await ensureThread();
      attemptedThreadId = id;
      const posted = await jsonFrom<MessageResponse>(await fetch(
        "/api/ai/threads/" + encodeURIComponent(id) + "/messages", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientMessageId, text, locale }),
        }));
      const page = await loadMessages(id);
      setMessages(page.items.length ? page.items : [posted.message, posted.reply]);
      setNextOffset(page.nextOffset);
      setOptimisticOwner(null);
      await refreshThreads();
      retryId.current = null;
      dispatchDictation({ type: "reset" }); setMediaNotice("");
    } catch {
      if (existingKey) retryId.current = null;
      // Server may have persisted the owner turn before the response failed.
      if (attemptedThreadId) {
        try {
          const page = await loadMessages(attemptedThreadId);
          setMessages(page.items); setNextOffset(page.nextOffset);
        } catch { /* do not fabricate a durable turn */ }
      }
      if (!existingKey) {
        setOptimisticOwner(null);
        setDraft(current=>current || text);
      }
      setError(true);
    } finally {
      setSending(false);
    }
  }
  async function loadOlder() {
    if (!threadId || nextOffset === null || loading) return;
    const node = transcript.current;
    previousScrollHeight.current = node ? node.scrollHeight : null;
    setLoading(true);
    try {
      const page = await loadMessages(threadId, nextOffset);
      setMessages((current) => {
        const known = new Set(current.map((msg) => msg.id));
        return [...page.items.filter((msg) => !known.has(msg.id)), ...current];
      });
      setNextOffset(page.nextOffset);
    } catch { setError(true); previousScrollHeight.current = null; }
    finally { setLoading(false); }
  }
  function selectThread(id: string | null) {
    if (sending) return;
    cleanupRecording(); dispatchDictation({ type: "reset" });
    setThreadId(id); setMessages([]); setNextOffset(null); setAttachments([]);
    setOptimisticOwner(null); setRecentTurnId(null);
    scrollNewestOnOpen.current = true; focusTurnId.current = null; ownerManuallyScrolled.current = false;
    setThreadTitle(threads.find((thread) => thread.id === id)?.title ?? null);
    setSnapshotExpanded(false);
    setDraft(""); setMediaNotice(""); setError(false); setHistoryOpen(false);
    retryId.current = null; threadRequestId.current = null;
    composer.current?.focus();
  }
  async function transcribeAudio(blob: Blob, durationSeconds: number, generation: number) {
    try {
      const extension = blob.type.startsWith("audio/mp4") ? "mp4" :
        blob.type.startsWith("audio/ogg") ? "ogg" : "webm";
      const body = new FormData();
      body.append("audio", new File([blob], "dictation." + extension, { type: blob.type }));
      body.append("durationSeconds", String(durationSeconds));
      const response = await jsonFrom<{ text: string }>(await fetch("/api/ai/transcribe", {
        method: "POST", credentials: "same-origin", body,
      }));
      if (recordingGeneration.current !== generation) return;
      const heard = response.text.trim();
      if (!heard) throw new Error("empty_transcript");
      setDraft((current) => ((current.trim() ? current.trimEnd() + " " : "") + heard).slice(0, 4000));
      retryId.current = null;
      dispatchDictation({ type: "result" }); setMediaNotice(copy.voiceReview);
      composer.current?.focus();
    } catch {
      if (recordingGeneration.current === generation) {
        dispatchDictation({ type: "error" }); setMediaNotice(copy.voiceError);
      }
    }
  }
  function stopRecording() {
    const active = recorder.current;
    if (!active || active.state === "inactive") return;
    dispatchDictation({ type: "stop" });
    setMediaNotice("");
    try { active.stop(); } catch { cleanupRecording(); dispatchDictation({ type: "error" }); setMediaNotice(copy.voiceError); }
  }
  async function listen() {
    if (!enabled || sending || uploading || dictation === "recognizing") return;
    if (recorder.current) { stopRecording(); return; }
    if (requestingMicrophone.current) return;
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      dispatchDictation({ type: "error" }); setMediaNotice(copy.voiceUnavailable); return;
    }
    let stream: MediaStream | null = null;
    requestingMicrophone.current = true;
    const generation = ++recordingGeneration.current;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== recordingGeneration.current) {
        stream.getTracks().forEach((track) => track.stop()); return;
      }
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]
        .find((candidate) => MediaRecorder.isTypeSupported(candidate));
      if (!mimeType) throw new Error("unsupported_audio");
      const active = new MediaRecorder(stream, { mimeType });
      recorder.current = active; recordingStream.current = stream;
      audioChunks.current = []; recordingStartedAt.current = Date.now(); setElapsed(0);
      active.ondataavailable = (event) => { if (event.data.size) audioChunks.current.push(event.data); };
      active.onerror = () => { cleanupRecording(); dispatchDictation({ type: "error" }); setMediaNotice(copy.voiceError); };
      active.onstop = () => {
        if (recorder.current !== active) return;
        const durationSeconds = Math.max(0.1, (Date.now() - recordingStartedAt.current) / 1000);
        const blob = new Blob(audioChunks.current, { type: active.mimeType.split(";")[0] });
        recorder.current = null;
        recordingStream.current?.getTracks().forEach((track) => track.stop());
        recordingStream.current = null; audioChunks.current = [];
        if (recordingLimit.current) clearTimeout(recordingLimit.current);
        recordingLimit.current = null;
        if (blob.size === 0 || blob.size > 8 * 1024 * 1024) {
          dispatchDictation({ type: "error" }); setMediaNotice(copy.voiceError); return;
        }
        void transcribeAudio(blob, durationSeconds, generation);
      };
      active.start(250);
      dispatchDictation({ type: "start" }); setMediaNotice("");
      recordingLimit.current = setTimeout(() => stopRecording(), 45_000);
    } catch {
      stream?.getTracks().forEach((track) => track.stop());
      if (generation === recordingGeneration.current) {
        cleanupRecording();
        dispatchDictation({ type: "error" }); setMediaNotice(copy.voicePermissionDenied);
      }
    } finally {
      requestingMicrophone.current = false;
    }
  }
  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !enabled || uploading || sending) return;
    if (file.size > 2 * 1024 * 1024 || file.size === 0) { setMediaNotice(copy.attachmentUpload); return; }
    setUploading(true); setError(false);
    try {
      const id = await ensureThread();
      const body = new FormData(); body.append("file", file);
      const result = await jsonFrom<{ attachment: StoredAttachment }>(await fetch(
        "/api/ai/threads/" + encodeURIComponent(id) + "/attachments", { method: "POST", body }));
      setAttachments((old) => [result.attachment, ...old]);
      setMediaNotice(copy.attachmentSaved);
      await refreshThreads();
    } catch { setError(true); setMediaNotice(copy.attachmentUpload); }
    finally { setUploading(false); }
  }
  function composerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void sendText(draft);
    }
  }

  // Structured Supervisor messages carry an explicit ownerMessageId. An unanswered
  // owner turn can occur anywhere in history, not only at the end of a thread.
  const displayedMessages: ConversationMessage[] = visibleConversationMessages(
    messages, optimisticOwner, threadId, new Date().toISOString());
  const answeredOwnerIds = new Set(messages.flatMap((message) =>
    message.role === "supervisor" && typeof message.grounding?.ownerMessageId === "string"
      ? [message.grounding.ownerMessageId] : []));
  const pendingOwnerIds = new Set(!sending ? messages
    .filter((message) => message.role === "owner" && Boolean(message.clientMessageId) &&
      !answeredOwnerIds.has(message.id))
    .map((message) => message.id) : []);
  const durationLabel = String(Math.floor(elapsed / 60)) + ":" + String(elapsed % 60).padStart(2, "0");

  return <section className="relative flex h-[calc(100dvh-11.5rem)] min-h-[360px] flex-col overflow-hidden rounded-[22px] border border-[#E2D3BF] bg-[#FFFDF9] shadow-sm md:h-[calc(100dvh-8rem)]"
    aria-label={copy.composerLabel}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#E9DAC8] bg-white/85 px-4 py-3 md:px-5">
      <button type="button" onClick={() => setHistoryOpen(true)} disabled={!enabled}
        aria-label={copy.historyTitle} title={copy.historyTitle}
        className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-xl text-ink hover:bg-[#F3ECE3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
        <History size={22} aria-hidden="true" />
      </button>
      <h2 className="min-w-0 flex-1 truncate text-center text-[16px] font-bold text-ink">
        {threadTitle || copy.supervisor}
      </h2>
      <Link href="/operations" title={copy.teamButton} aria-label={copy.teamButton}
        className="inline-flex min-h-12 items-center gap-1 rounded-xl px-2 text-[14px] font-bold text-ink no-underline hover:bg-[#F3ECE3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
        <UsersRound size={19} aria-hidden="true" /><span className="hidden sm:inline">{copy.teamButton}</span>
      </Link>
      <button type="button" onClick={() => selectThread(null)} disabled={!enabled || sending}
        aria-label={copy.startNewChat} title={copy.startNewChat}
        className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-xl text-ink hover:bg-[#F2EBDF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
        <Plus size={22} aria-hidden="true" />
      </button>
    </header>
    <div ref={transcript} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-4 md:px-6 md:py-5"
      onWheel={() => { ownerManuallyScrolled.current = true; }}
      onTouchStart={() => { ownerManuallyScrolled.current = true; }}
      role="log" aria-live="polite" aria-label={copy.threads}>
      {displayedMessages.length === 0 && <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-2 py-3 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#E9F1E8] text-good">
          <Coffee aria-hidden="true" size={27} strokeWidth={2.2} />
        </div>
        <h2 className="font-headline text-2xl font-bold text-ink">{copy.emptyHeading}</h2>
        <p className="max-w-md text-[17px] leading-relaxed text-ink-muted">{copy.emptyIntro}</p>
        {snapshot && <section className="w-full rounded-xl bg-[#F8F2E9] p-3 text-start">
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {snapshot.stats.slice(0,3).map(stat=><span key={stat.label} className="text-[14px] text-ink">
              <span className="text-ink-muted">{stat.label}: </span><strong>{stat.value}</strong>
            </span>)}
            <span className="text-[14px] text-ink">
              <span className="text-ink-muted">{snapshot.sections[0]?.title}: </span>
              <strong>{snapshot.sections[0]?.count ?? 0}</strong>
            </span>
          </div>
          <button type="button" onClick={()=>setSnapshotExpanded(v=>!v)}
            aria-expanded={snapshotExpanded} className="mt-1 inline-flex min-h-12 items-center gap-1 text-sm font-bold text-good">
            {snapshotExpanded ? copy.snapshotCollapse : copy.snapshotExpand}
            <ChevronDown size={16} className={snapshotExpanded ? "rotate-180" : ""} aria-hidden="true" />
          </button>
          {snapshotExpanded && <HomeSnapshot snapshot={snapshot} />}
        </section>}
        <div className="mt-2 flex max-w-[640px] flex-wrap justify-center gap-2">
          {copy.suggestions.map((suggestion) =>
            <button key={suggestion} type="button" disabled={!enabled || sending}
              onClick={() => { setDraft(suggestion); retryId.current = null; composer.current?.focus(); }}
              className="min-h-12 rounded-2xl border border-[#D9CAB8] bg-white px-4 py-3 text-start text-[15px] font-semibold text-ink shadow-sm transition-colors hover:bg-[#F6EBDD] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
              {suggestion}
            </button>)}
        </div>
        {!enabled && <p className="text-[16px] text-ink-muted">{copy.unavailable}</p>}
      </div>}
      {displayedMessages.length > 0 && snapshot && <section className="mb-4 rounded-xl border border-[#E2D3BF] bg-[#F6F0E7] p-2">
        <button type="button" onClick={() => setSnapshotExpanded((v) => !v)}
          aria-expanded={snapshotExpanded}
          aria-label={snapshotExpanded ? copy.snapshotCollapse : copy.snapshotExpand}
          className="flex min-h-10 w-full items-center justify-between gap-2 px-2 text-start text-sm font-semibold text-ink">
          <span>{copy.todaySummary} · {snapshot.stats[0]?.value} · {snapshot.sections[0]?.count ?? 0} {copy.needsYou}</span>
          <ChevronDown size={18} className={snapshotExpanded ? "rotate-180" : ""} aria-hidden="true" />
        </button>
        {snapshotExpanded && <div className="p-2"><HomeSnapshot snapshot={snapshot} /></div>}
      </section>}
      {nextOffset !== null && <button type="button" onClick={() => void loadOlder()} disabled={loading}
        className="mx-auto flex min-h-12 items-center gap-2 rounded-xl px-4 text-[15px] font-semibold text-ink underline hover:bg-[#F4EBDD]">
        <Clock3 size={18} aria-hidden="true" /> {copy.more}
      </button>}
      {displayedMessages.map((message) => <div key={message.id} data-client-message-id={message.role === "owner" ? message.clientMessageId ?? undefined : undefined} className="space-y-2">
        <SupervisorMessage message={message} copy={copy} locale={locale} />
        {pendingOwnerIds.has(message.id) && <div className="flex max-w-[94%] items-center gap-3 rounded-xl border border-[#F2D59F] bg-[#FFF3DD] p-3 text-[15px] text-ink" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span className="flex-1">{copy.answerFailed}</span>
          <button type="button" onClick={() => void sendText(message.text ?? "", message.clientMessageId ?? undefined)}
            className="min-h-10 rounded-xl bg-ink px-3 font-bold text-white">{copy.retryAnswer}</button>
        </div>}
      </div>)}
      {sending && <div className="flex items-center gap-3 text-[16px] text-ink-muted" role="status">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-good motion-reduce:animate-none" />
        {copy.sending}
      </div>}
      {recentTurnId && <div ref={tailSpacer} aria-hidden="true" className="pointer-events-none shrink-0" />}
    </div>
    <div className="shrink-0 border-t border-[#E9DAC8] bg-[#FFF9F1] px-2 py-2 md:px-4">
      {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2" aria-label={copy.addAttachment}>
        {attachments.map((file) => <a key={file.id}
          href={"/api/ai/threads/" + encodeURIComponent(threadId ?? "") + "/attachments/" + encodeURIComponent(file.id)}
          target="_blank" rel="noopener noreferrer"
          className="inline-flex max-w-full min-h-10 items-center gap-2 rounded-xl bg-white px-3 text-[14px] font-semibold text-ink underline">
          <Paperclip size={17} aria-hidden="true" /><span className="truncate">{file.originalName}</span>
        </a>)}
      </div>}
      <form onSubmit={(event) => { event.preventDefault(); void sendText(draft); }}
        className="flex items-end gap-1 rounded-[22px] border border-[#D8C8B5] bg-white p-1.5 shadow-sm">
        <input ref={filePicker} type="file" className="sr-only"
          accept=".txt,.pdf,.jpg,.jpeg,.png,.webp,text/plain,application/pdf,image/jpeg,image/png,image/webp"
          onChange={(event) => void attach(event)} />
        <button type="button" onClick={() => filePicker.current?.click()}
          aria-label={copy.addAttachment} title={copy.addAttachment}
          disabled={!enabled || sending || uploading || dictation === "listening" || dictation === "recognizing"}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-[#F2EBE0] disabled:opacity-50">
          <Plus size={22} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => void listen()}
          aria-label={dictation === "listening" ? copy.voiceStop : copy.voiceInput}
          title={dictation === "listening" ? copy.voiceStop : copy.voiceInput}
          aria-pressed={dictation === "listening"}
          disabled={!enabled || sending || uploading || dictation === "recognizing"}
          className={dictation === "listening"
            ? "flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-red-600 text-white ring-2 ring-red-200 animate-pulse motion-reduce:animate-none"
            : "flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-good hover:bg-[#E6F1E8] disabled:opacity-40"}>
          {dictation === "listening" ? <Square size={20} fill="currentColor" aria-hidden="true" />
            : dictation === "recognizing" ? <LoaderCircle size={21} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <Mic size={22} aria-hidden="true" />}
        </button>
        <label htmlFor="supervisor-home-composer" className="sr-only">{copy.askAnything}</label>
        <textarea id="supervisor-home-composer" ref={composer}
          rows={1} maxLength={4000} value={draft}
          onChange={(event) => { setDraft(event.target.value); retryId.current = null; }}
          onKeyDown={composerKey} disabled={!enabled || sending}
          placeholder={copy.askAnything}
          className="min-w-0 max-h-40 min-h-12 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-3 text-[17px] leading-6 text-ink outline-none placeholder:text-ink-muted disabled:opacity-50" />
        <button type="submit" aria-label={copy.sendMessage}
          disabled={!enabled || sending || !draft.trim() || dictation === "listening" || dictation === "recognizing"}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink text-white shadow-sm hover:bg-[#463125] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40">
          <Send size={21} aria-hidden="true" />
        </button>
      </form>
      {dictation === "listening" && <p className="mt-1 text-sm font-bold text-red-700" role="status">
        {copy.recording} {durationLabel} · {copy.voiceStop}
      </p>}
      {dictation === "recognizing" && <p className="mt-1 text-sm font-semibold text-ink-muted" role="status">
        {copy.transcribing}
      </p>}
      <div role="status" aria-live="polite" className="text-[14px] font-medium text-ink-muted">
        {error && pendingOwnerIds.size === 0 ? copy.answerFailed : uploading ? copy.attachmentUpload
          : dictation === "error" || dictation === "ready" ? mediaNotice
            : mediaNotice === copy.attachmentSaved ? mediaNotice : ""}
      </div>
    </div>
    {historyOpen && <div className="absolute inset-0 z-30 flex" role="presentation">
      <button type="button" className="absolute inset-0 bg-[#21150F]/35" aria-label={copy.closeHistory}
        onClick={() => setHistoryOpen(false)} />
      <aside role="dialog" aria-modal="true" aria-label={copy.historyTitle}
        className="relative z-10 flex h-full w-[min(88%,360px)] flex-col border-e border-[#E1D4C2] bg-[#FFF9F1] shadow-xl">
        <header className="flex items-center justify-between gap-3 border-b border-[#E1D4C2] px-5 py-4">
          <h2 className="flex items-center gap-2 font-headline text-xl font-bold text-ink">
            <History aria-hidden="true" size={22} />{copy.historyTitle}
          </h2>
          <button type="button" onClick={() => setHistoryOpen(false)}
            aria-label={copy.closeHistory}
            className="flex h-12 w-12 items-center justify-center rounded-xl text-ink hover:bg-[#EEE4D6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
            <X size={24} aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1 space-y-1 overflow-y-auto p-3">
          <button type="button" onClick={() => selectThread(null)}
            className="flex min-h-12 w-full items-center gap-2 rounded-xl px-3 text-start text-[17px] font-bold text-good hover:bg-[#EBE8DB]">
            <Plus size={20} aria-hidden="true" /> {copy.startNewChat}
          </button>
          {threads.length === 0 && <p className="p-4 text-[16px] text-ink-muted">{copy.empty}</p>}
          {threads.map((thread) => <button key={thread.id} type="button"
            onClick={() => selectThread(thread.id)} disabled={sending}
            aria-current={threadId === thread.id ? "page" : undefined}
            className={"flex min-h-14 w-full flex-col justify-center gap-1 rounded-xl px-3 py-2 text-start hover:bg-[#EFE7DA] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink " +
              (threadId === thread.id ? "bg-[#E7EEDD]" : "")}>
            <span className="line-clamp-2 text-[16px] font-semibold text-ink">{thread.title || copy.newThread}</span>
            <span className="text-[13px] text-ink-muted">
              {new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(thread.lastMessageAt ?? thread.createdAt))}
            </span>
          </button>)}
        </div>
        {usage && <div className="border-t border-[#E1D4C2] p-4 text-[15px] text-ink-muted">
          <p className="mb-2 font-bold text-ink">{copy.usageHeading}</p>
          <p>{copy.usageRequests}: {new Intl.NumberFormat(locale).format(usage.requests)}</p>
          <p>{copy.usageTokens}: {new Intl.NumberFormat(locale).format(usage.inputTokens + usage.outputTokens)}</p>
          <p>{copy.usageEstimate}: {usage.estimatedCostMicros === null
            ? copy.usageCostUnknown
            : new Intl.NumberFormat(locale, { style: "currency", currency: "USD",
              minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(usage.estimatedCostMicros / 1_000_000)}</p>
        </div>}
      </aside>
    </div>}
  </section>;
}
