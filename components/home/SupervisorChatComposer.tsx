"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Plus, Send } from "lucide-react";
import { formatCents } from "@/lib/calc";
import type { ConversationMessage, ConversationPage, ConversationThread } from "@/lib/ai/conversations/contracts";

export type SupervisorChatCopy = {
  askAnything: string;
  composerLabel: string;
  addAttachment: string;
  voiceInput: string;
  sendMessage: string;
  comingSoon: string;
  live: string;
  suggestions: string[];
  threads: string;
  newThread: string;
  empty: string;
  loading: string;
  sending: string;
  retry: string;
  unavailable: string;
  more: string;
  you: string;
  supervisor: string;
  source: string;
};
type Locale = "en" | "es" | "ar";

type MessageResponse = {
  message: ConversationMessage;
  reply: ConversationMessage;
  replyStatus: "complete";
};

async function jsonFrom<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error("conversation_request_failed");
  return response.json() as Promise<T>;
}

async function loadMessages(id: string, offset = 0): Promise<ConversationPage<ConversationMessage>> {
  return jsonFrom<ConversationPage<ConversationMessage>>(
    await fetch("/api/ai/threads/" + encodeURIComponent(id) + "/messages?offset=" + offset,
      { credentials: "same-origin", cache: "no-store" }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function SupervisorMessage({ message, copy }: { message: ConversationMessage; copy: SupervisorChatCopy }) {
  const isOwner = message.role === "owner";
  return (
    <article className={isOwner
      ? "ms-8 rounded-2xl bg-[#F0E5D8] p-3"
      : "me-8 rounded-2xl border border-[#D8C8B5] bg-white p-3"}>
      <p className="mb-1 text-sm font-bold text-ink-muted">{isOwner ? copy.you : copy.supervisor}</p>
      {isOwner ? <p className="whitespace-pre-wrap break-words text-[17px] text-ink">{message.text}</p> :
        <div className="flex flex-col gap-2">
          {(message.blocks ?? []).map((block, index) => {
            if (!isRecord(block)) return null;
            if ((block.type === "text" || block.type === "warning") && typeof block.text === "string") {
              return <p key={index} className={block.type === "warning"
                ? "rounded-xl bg-[#FFF1D8] p-3 text-[17px] leading-relaxed text-ink"
                : "whitespace-pre-wrap break-words text-[17px] leading-relaxed text-ink"}>{block.text}</p>;
            }
            if (block.type === "metric" && typeof block.label === "string" &&
                typeof block.valueCents === "number" && Number.isSafeInteger(block.valueCents)) {
              const source = isRecord(block.source) ? block.source : null;
              return <div key={index} className="rounded-xl bg-[#F3F7F4] p-3">
                <p className="text-[17px] font-semibold text-ink">{block.label}</p>
                <p className="font-headline text-2xl font-bold text-ink">{formatCents(block.valueCents)}</p>
                {source && <p className="mt-1 break-all text-sm text-ink-muted">
                  {copy.source}: {String(source.source ?? "")} · {String(source.asOf ?? "")}
                </p>}
              </div>;
            }
            return null;
          })}
        </div>}
    </article>
  );
}

/** A conversation UI, not an agent simulator: only server-persisted messages
 * and verified structured replies render here. No local fake AI response.
 */
export default function SupervisorChatComposer({
  enabled, locale, copy,
}: { enabled: boolean; locale: Locale; copy: SupervisorChatCopy }) {
  const [threads, setThreads] = useState<ConversationThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const retryId = useRef<string | null>(null);
  const threadRequestId = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void fetch("/api/ai/threads", { signal: controller.signal, cache: "no-store" })
      .then((response) => jsonFrom<ConversationPage<ConversationThread>>(response))
      .then((page) => {
        if (controller.signal.aborted) return;
        setThreads(page.items);
        if (page.items.length) setThreadId(page.items[0].id);
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !threadId) return;
    const controller = new AbortController();
    void fetch("/api/ai/threads/" + encodeURIComponent(threadId) + "/messages?offset=0",
      { signal: controller.signal, cache: "no-store" })
      .then((response) => jsonFrom<ConversationPage<ConversationMessage>>(response))
      .then((page) => {
        if (!controller.signal.aborted) {
          setMessages(page.items);
          setNextOffset(page.nextOffset);
        }
      })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [enabled, threadId]);

  async function refreshThreads() {
    const page = await jsonFrom<ConversationPage<ConversationThread>>(
      await fetch("/api/ai/threads", { cache: "no-store" }),
    );
    setThreads(page.items);
  }

  async function sendText(input: string) {
    const text = input.trim();
    if (!enabled || !text || sending || text.length > 4000) return;
    setSending(true);
    setError(false);
    try {
      let id = threadId;
      if (!id) {
        threadRequestId.current ??= crypto.randomUUID();
        const created = await jsonFrom<{ thread: ConversationThread }>(
          await fetch("/api/ai/threads", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: threadRequestId.current }),
          }),
        );
        id = created.thread.id;
        setThreadId(id);
        threadRequestId.current = null;
      }
      retryId.current ??= crypto.randomUUID();
      await jsonFrom<MessageResponse>(await fetch(
        "/api/ai/threads/" + encodeURIComponent(id) + "/messages", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientMessageId: retryId.current, text, locale }),
        },
      ));
      const page = await loadMessages(id);
      setMessages(page.items);
      setNextOffset(page.nextOffset);
      await refreshThreads();
      setDraft("");
      retryId.current = null;
    } catch {
      // Preserve both the draft and idempotency key so retry cannot duplicate an
      // owner message, even when it was saved before a tool or connection failed.
      setError(true);
    } finally {
      setSending(false);
    }
  }

  async function loadOlder() {
    if (!threadId || nextOffset === null || loading) return;
    setLoading(true);
    try {
      const page = await loadMessages(threadId, nextOffset);
      setMessages((current) => {
        const known = new Set(current.map((m) => m.id));
        return [...page.items.filter((m) => !known.has(m.id)), ...current];
      });
      setNextOffset(page.nextOffset);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  function selectThread(id: string | null) {
    if (sending) return;
    setThreadId(id);
    setMessages([]);
    setNextOffset(null);
    setError(false);
    setDraft("");
    retryId.current = null;
    threadRequestId.current = null;
  }

  return (
    <div className="mt-5">
      {enabled && <div className="mb-3 flex flex-wrap items-center gap-2">
        <label htmlFor="supervisor-thread-picker" className="sr-only">{copy.threads}</label>
        <select id="supervisor-thread-picker" value={threadId ?? ""}
          disabled={sending}
          onChange={(event) => selectThread(event.target.value || null)}
          className="min-h-12 min-w-0 flex-1 rounded-xl border border-[#D8C8B5] bg-white px-3 text-[17px] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
          <option value="">{copy.newThread}</option>
          {threads.map((thread) =>
            <option key={thread.id} value={thread.id}>{thread.title ?? copy.newThread}</option>)}
        </select>
        <button type="button" onClick={() => selectThread(null)} disabled={sending}
          className="min-h-12 rounded-xl bg-ink px-4 text-[17px] font-bold text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
          {copy.newThread}
        </button>
      </div>}

      {enabled && <div className="mb-3 max-h-[320px] min-h-[72px] space-y-3 overflow-y-auto rounded-2xl border border-[#D8C8B5] bg-[#FFF8EF]/80 p-3"
        role="log" aria-label={copy.threads} aria-live="polite">
        {messages.length === 0 && <p className="text-[17px] text-ink-muted">{copy.empty}</p>}
        {nextOffset !== null && <button type="button" onClick={() => void loadOlder()}
          disabled={loading}
          className="min-h-12 w-full rounded-xl bg-white px-3 text-[17px] font-bold text-ink underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
          {copy.more}
        </button>}
        {messages.map((message) => <SupervisorMessage key={message.id} message={message} copy={copy} />)}
      </div>}

      <form onSubmit={(event) => { event.preventDefault(); void sendText(draft); }}
        className="rounded-[24px] border border-[#D8C8B5] bg-card/95 p-2 shadow-[0_10px_30px_rgba(42,29,20,0.08)]">
        <div className="flex min-h-14 items-center gap-2" role="group" aria-label={copy.composerLabel}>
          <button type="button" disabled aria-label={copy.addAttachment}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#F3ECE3] text-ink-muted disabled:cursor-not-allowed">
            <Plus aria-hidden="true" size={24} />
          </button>
          <label htmlFor="supervisor-home-composer" className="sr-only">{copy.askAnything}</label>
          <input id="supervisor-home-composer" type="text"
            value={draft} onChange={(event) => { setDraft(event.target.value); retryId.current = null; }}
            maxLength={4000} disabled={!enabled || sending}
            placeholder={copy.askAnything}
            className="min-w-0 flex-1 bg-transparent px-1 text-[17px] font-semibold text-ink outline-none placeholder:text-ink-muted disabled:cursor-not-allowed" />
          <button type="button" disabled aria-label={copy.voiceInput}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#E8F1EE] text-good disabled:cursor-not-allowed">
            <Mic aria-hidden="true" size={22} />
          </button>
          <button type="submit" disabled={!enabled || sending || !draft.trim()}
            aria-label={copy.sendMessage}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink text-paper disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            <Send aria-hidden="true" size={20} />
          </button>
        </div>
      </form>

      <p className="mt-2 text-[15px] font-medium text-ink-muted">{enabled ? copy.live : copy.comingSoon}</p>
      <div role="status" aria-live="polite" className="mt-1 text-[17px] text-ink">
        {sending && copy.sending}
        {error && (enabled ? copy.retry : copy.unavailable)}
      </div>
      <div className="-mx-1 mt-3 flex snap-x gap-2 overflow-x-auto px-1 pb-1 md:flex-wrap" aria-label={copy.composerLabel}>
        {copy.suggestions.map((suggestion) => (
          <button key={suggestion} type="button" disabled={!enabled || sending}
            onClick={() => { setDraft(suggestion); retryId.current = null; void sendText(suggestion); }}
            className="min-h-12 shrink-0 snap-start rounded-full border border-[#D8C8B5] bg-card px-4 text-[17px] font-bold text-ink shadow-sm disabled:cursor-not-allowed disabled:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
