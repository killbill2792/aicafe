"use client";

import { useEffect, useReducer, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Clock3, History, Mic, Plus, Send, Sparkles, Square, X, Check, AlertCircle, Paperclip } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import { nextDictationStage } from "@/lib/ai/conversations/dictationState";
import type { StoredAttachment } from "@/lib/ai/conversations/attachments";
import type { SupervisorChatUnavailableReason } from "@/lib/ai/conversations/readiness";
import type { ConversationMessage, ConversationPage, ConversationThread } from "@/lib/ai/conversations/contracts";

export type SupervisorChatCopy = {
  askAnything: string; composerLabel: string; addAttachment: string; voiceInput: string; sendMessage: string;
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
};
type Locale = "en" | "es" | "ar";
type SpeechRecognizer = {
  lang: string; interimResults: boolean; continuous?: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null;
  start: () => void; stop: () => void;
};
type MessageResponse = { message: ConversationMessage; reply: ConversationMessage; replyStatus: "complete" };
function recognitionForBrowser(): SpeechRecognizer | null {
  const w = window as Window & {
    SpeechRecognition?: new () => SpeechRecognizer;
    webkitSpeechRecognition?: new () => SpeechRecognizer;
  };
  const Recognizer = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Recognizer ? new Recognizer() : null;
}
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
    return <div className="rounded-2xl border border-[#D8E7D9] bg-[#F2F8F3] p-4 shadow-sm">
      <p className="text-[15px] font-semibold text-ink-muted">{block.label}</p>
      <p className="mt-1 font-headline text-3xl font-extrabold tracking-tight text-ink">
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

export default function SupervisorChatComposer({
  enabled, locale, copy, onActivityChange,
}: {
  enabled: boolean; unavailableReason: SupervisorChatUnavailableReason | null;
  locale: Locale; copy: SupervisorChatCopy; onActivityChange?: (active: boolean) => void;
}) {
  const [threads, setThreads] = useState<ConversationThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [dictation, dispatchDictation] = useReducer(nextDictationStage, "idle");
  const [uploading, setUploading] = useState(false);
  const [attachments, setAttachments] = useState<StoredAttachment[]>([]);
  const [mediaNotice, setMediaNotice] = useState("");
  const speech = useRef<SpeechRecognizer | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const transcript = useRef<HTMLDivElement | null>(null);
  const previousScrollHeight = useRef<number | null>(null);
  const retryId = useRef<string | null>(null);
  const threadRequestId = useRef<string | null>(null);

  function cleanupSpeech() {
    const active = speech.current;
    speech.current = null;
    if (active) {
      active.onresult = null; active.onerror = null; active.onend = null;
      try { active.stop(); } catch { /* Browser recognition already ended. */ }
    }
  }
  useEffect(() => () => {
    const active = speech.current;
    speech.current = null;
    if (active) {
      active.onresult = null; active.onerror = null; active.onend = null;
      try { active.stop(); } catch { /* cleanup */ }
    }
  }, []);
  useEffect(() => {
    if (!enabled) {
      const active = speech.current;
      speech.current = null;
      if (active) {
        active.onresult = null; active.onerror = null; active.onend = null;
        try { active.stop(); } catch { /* cleanup */ }
      }
      dispatchDictation({ type: "reset" });
    }
  }, [enabled]);
  useEffect(() => { onActivityChange?.(messages.length > 0); }, [messages.length, onActivityChange]);
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
      .then((page) => { if (!controller.signal.aborted) setThreads(page.items); })
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
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [enabled, threadId, sending]);
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
  useEffect(() => {
    const node = transcript.current;
    if (!node) return;
    if (previousScrollHeight.current !== null) {
      node.scrollTop = node.scrollHeight - previousScrollHeight.current + node.scrollTop;
      previousScrollHeight.current = null;
    } else {
      node.scrollTo({ top: node.scrollHeight, behavior: "auto" });
    }
  }, [messages]);

  async function refreshThreads() {
    const page = await jsonFrom<ConversationPage<ConversationThread>>(
      await fetch("/api/ai/threads", { cache: "no-store" }));
    setThreads(page.items);
  }
  async function ensureThread(): Promise<string> {
    if (threadId) return threadId;
    threadRequestId.current ??= crypto.randomUUID();
    const created = await jsonFrom<{ thread: ConversationThread }>(await fetch("/api/ai/threads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: threadRequestId.current }),
    }));
    setThreadId(created.thread.id);
    threadRequestId.current = null;
    return created.thread.id;
  }
  async function sendText(value: string) {
    const text = value.trim();
    if (!enabled || !text || sending || uploading || speech.current || dictation === "recognizing" || text.length > 4000) return;
    setSending(true); setError(false);
    try {
      const id = await ensureThread();
      retryId.current ??= crypto.randomUUID();
      const posted = await jsonFrom<MessageResponse>(await fetch(
        "/api/ai/threads/" + encodeURIComponent(id) + "/messages", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientMessageId: retryId.current, text, locale }),
        }));
      const page = await loadMessages(id);
      setMessages(page.items.length ? page.items : [posted.message, posted.reply]);
      setNextOffset(page.nextOffset);
      await refreshThreads();
      setDraft(""); retryId.current = null;
      dispatchDictation({ type: "reset" }); setMediaNotice("");
    } catch {
      // Draft and retry key are preserved even if a reply or connection failed after owner insert.
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
    cleanupSpeech(); dispatchDictation({ type: "reset" });
    setThreadId(id); setMessages([]); setNextOffset(null); setAttachments([]);
    setDraft(""); setMediaNotice(""); setError(false); setHistoryOpen(false);
    retryId.current = null; threadRequestId.current = null;
    composer.current?.focus();
  }
  function listen() {
    if (!enabled || sending || uploading || dictation === "recognizing") return;
    if (speech.current) {
      dispatchDictation({ type: "stop" });
      setMediaNotice(copy.voiceProcessing);
      try { speech.current.stop(); } catch { cleanupSpeech(); dispatchDictation({ type: "error" }); }
      return;
    }
    const recognition = recognitionForBrowser();
    if (!recognition) {
      dispatchDictation({ type: "error" }); setMediaNotice(copy.voiceUnavailable); return;
    }
    speech.current = recognition;
    let resultReceived = false;
    let errored = false;
    recognition.lang = locale === "ar" ? "ar-SA" : locale === "es" ? "es-ES" : "en-US";
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      if (speech.current !== recognition) return;
      const heard = Array.from(event.results).map((r) => r[0]?.transcript ?? "").join(" ").trim();
      if (!heard) return;
      resultReceived = true;
      setDraft((current) => ((current.trim() ? current.trimEnd() + " " : "") + heard).slice(0, 4000));
      retryId.current = null;
      dispatchDictation({ type: "result" }); setMediaNotice(copy.voiceReview);
      composer.current?.focus();
    };
    recognition.onerror = (event) => {
      if (speech.current !== recognition) return;
      errored = true;
      dispatchDictation({ type: "error" });
      setMediaNotice(event.error === "not-allowed" || event.error === "service-not-allowed"
        ? copy.voicePermissionDenied : event.error === "no-speech" ? copy.voiceNoSpeech
          : event.error === "aborted" ? copy.voiceCanceled : copy.voiceError);
    };
    recognition.onend = () => {
      if (speech.current !== recognition) return;
      speech.current = null;
      dispatchDictation({ type: "end", hadResult: resultReceived, hadError: errored });
      if (!resultReceived && !errored) setMediaNotice(copy.voiceNoSpeech);
    };
    try {
      recognition.start();
      dispatchDictation({ type: "start" }); setMediaNotice(copy.listening);
    } catch {
      cleanupSpeech(); dispatchDictation({ type: "error" }); setMediaNotice(copy.voiceError);
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

  return <section className="relative mt-4 flex h-[min(75vh,790px)] min-h-[530px] flex-col overflow-hidden rounded-[26px] border border-[#E2D3BF] bg-[#FFFDF9] shadow-[0_14px_38px_rgba(45,31,22,0.09)]"
    aria-label={copy.composerLabel}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#E9DAC8] bg-white/85 px-4 py-3 md:px-5">
      <button type="button" onClick={() => setHistoryOpen(true)} disabled={!enabled}
        aria-label={copy.historyTitle} title={copy.historyTitle}
        className="inline-flex min-h-12 items-center gap-2 rounded-xl px-3 text-[17px] font-bold text-ink hover:bg-[#F3ECE3] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
        <History size={22} aria-hidden="true" />
        <span>{copy.threads}</span>
      </button>
      <button type="button" onClick={() => selectThread(null)} disabled={!enabled || sending}
        aria-label={copy.startNewChat} title={copy.startNewChat}
        className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-[#F2EBDF] px-4 text-[16px] font-bold text-ink hover:bg-[#E8DECF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
        <Plus size={21} aria-hidden="true" /><span className="hidden sm:inline">{copy.newThread}</span>
      </button>
    </header>
    <div ref={transcript} className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-5 md:px-8 md:py-7"
      role="log" aria-live="polite" aria-label={copy.threads}>
      {messages.length === 0 && <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 py-8 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-[28px] bg-[#E9F1E8] text-good shadow-inner">
          <Sparkles aria-hidden="true" size={42} />
        </div>
        <h2 className="font-headline text-3xl font-bold text-ink">{copy.emptyHeading}</h2>
        <p className="max-w-md text-[17px] leading-relaxed text-ink-muted">{copy.emptyIntro}</p>
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
      {nextOffset !== null && <button type="button" onClick={() => void loadOlder()} disabled={loading}
        className="mx-auto flex min-h-12 items-center gap-2 rounded-xl px-4 text-[15px] font-semibold text-ink underline hover:bg-[#F4EBDD]">
        <Clock3 size={18} aria-hidden="true" /> {copy.more}
      </button>}
      {messages.map((message) =>
        <SupervisorMessage key={message.id} message={message} copy={copy} locale={locale} />)}
      {sending && <div className="flex items-center gap-3 text-[16px] text-ink-muted" role="status">
        <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-good motion-reduce:animate-none" />
        {copy.sending}
      </div>}
    </div>
    <div className="shrink-0 border-t border-[#E9DAC8] bg-[#FFF9F1] px-3 py-3 shadow-[0_-8px_20px_rgba(44,30,20,0.03)] md:px-5">
      {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2" aria-label={copy.addAttachment}>
        {attachments.map((file) => <a key={file.id}
          href={"/api/ai/threads/" + encodeURIComponent(threadId ?? "") + "/attachments/" + encodeURIComponent(file.id)}
          target="_blank" rel="noopener noreferrer"
          className="inline-flex max-w-full min-h-10 items-center gap-2 rounded-xl bg-white px-3 text-[14px] font-semibold text-ink underline">
          <Paperclip size={17} aria-hidden="true" /><span className="truncate">{file.originalName}</span>
        </a>)}
      </div>}
      {(dictation === "listening" || dictation === "recognizing") && <div id="supervisor-dictation-state" role="status" aria-live="polite"
        className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-good bg-[#E8F3E8] px-4 py-3 text-[17px] font-bold text-ink shadow-sm">
        <span className="inline-flex items-center gap-3">
          <span className="relative flex h-4 w-4">
            {dictation === "listening" && <span className="absolute h-4 w-4 animate-ping rounded-full bg-good/40 motion-reduce:animate-none" />}
            <span className="relative h-4 w-4 rounded-full bg-good" />
          </span>
          {dictation === "listening" ? copy.listening : copy.voiceProcessing}
        </span>
        {dictation === "listening" && <button type="button" onClick={listen}
          className="min-h-12 rounded-full bg-ink px-5 text-[17px] font-bold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          {copy.voiceStop}
        </button>}
      </div>}
      {dictation === "ready" && <p role="status" className="mb-2 flex items-center gap-2 text-[15px] font-semibold text-good">
        <Check size={18} aria-hidden="true" /> {copy.voiceReview}
      </p>}
      <form onSubmit={(event) => { event.preventDefault(); void sendText(draft); }}
        className="rounded-[23px] border border-[#D8C8B5] bg-white p-2 shadow-[0_5px_18px_rgba(42,29,20,0.06)]">
        <label htmlFor="supervisor-home-composer" className="sr-only">{copy.askAnything}</label>
        <textarea id="supervisor-home-composer" ref={composer}
          rows={2} maxLength={4000} value={draft}
          onChange={(event) => { setDraft(event.target.value); retryId.current = null; }}
          onKeyDown={composerKey} disabled={!enabled || sending}
          placeholder={copy.askAnything}
          className="max-h-44 min-h-[64px] w-full resize-y rounded-xl bg-transparent px-3 py-2 text-[17px] leading-relaxed text-ink outline-none placeholder:text-ink-muted disabled:opacity-50" />
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <input ref={filePicker} type="file" className="sr-only"
              accept=".txt,.pdf,.jpg,.jpeg,.png,.webp,text/plain,application/pdf,image/jpeg,image/png,image/webp"
              onChange={(event) => void attach(event)} />
            <button type="button" onClick={() => filePicker.current?.click()}
              aria-label={copy.addAttachment} title={copy.addAttachment}
              disabled={!enabled || sending || uploading}
              className="flex h-12 w-12 items-center justify-center rounded-full text-ink-muted hover:bg-[#F2EBE0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
              <Plus size={23} aria-hidden="true" />
            </button>
            <button type="button" onClick={listen}
              aria-label={dictation === "listening" ? copy.voiceStop : copy.voiceInput}
              title={dictation === "listening" ? copy.voiceStop : copy.voiceInput}
              aria-pressed={dictation === "listening"} aria-controls="supervisor-dictation-state"
              disabled={!enabled || sending || uploading || dictation === "recognizing"}
              className={dictation === "listening"
                ? "flex h-12 w-12 items-center justify-center rounded-full bg-good text-white ring-4 ring-good/25 shadow-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
                : "flex h-12 w-12 items-center justify-center rounded-full text-good hover:bg-[#E6F1E8] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-40"}>
              {dictation === "listening" ? <Square size={21} fill="currentColor" aria-hidden="true" />
                : <Mic size={23} aria-hidden="true" />}
            </button>
          </div>
          <button type="submit" aria-label={copy.sendMessage}
            disabled={!enabled || sending || !draft.trim() || dictation === "listening" || dictation === "recognizing"}
            className="flex h-12 min-w-12 items-center justify-center rounded-full bg-ink text-white shadow-sm hover:bg-[#463125] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40">
            <Send size={21} aria-hidden="true" />
          </button>
        </div>
      </form>
      <div role="status" aria-live="polite" className="mt-1 min-h-5 text-[14px] font-medium text-ink-muted">
        {error ? copy.retry : uploading ? copy.attachmentUpload
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
      </aside>
    </div>}
  </section>;
}
