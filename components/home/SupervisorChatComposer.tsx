"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { StoredAttachment } from "@/lib/ai/conversations/attachments";
import {appendSpeech,speechChunks} from "@/lib/ai/conversations/speechResults";
import type { SupervisorChatUnavailableReason } from "@/lib/ai/conversations/readiness";
import { Mic, MicOff, Plus, Send } from "lucide-react";
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
  listening: string;
  voiceReview: string;
  voiceUnavailable: string;
  voiceStarting: string;
  voiceStop: string;
  voiceProcessing: string;
  voiceNoSpeech: string;
  attachmentSaved: string;
  attachmentNotice: string;
  attachmentUpload: string;
  statusDisabled: string;
  statusDatabase: string;
  statusWriter: string;
  statusOwner: string;
  statusStorage: string;
};
type Locale = "en" | "es" | "ar";
type SpeechRecognizer = {
 lang:string; interimResults:boolean;
 onresult:((event:{results:ArrayLike<ArrayLike<{transcript:string}> & {isFinal?:boolean}>})=>void)|null;
 onstart:(()=>void)|null; onerror:((event:{error?:string})=>void)|null;
 onend:(()=>void)|null; start:()=>void; stop:()=>void;
};
function recognitionForBrowser():SpeechRecognizer|null {
 const w=window as Window & {
  SpeechRecognition?:new()=>SpeechRecognizer;
  webkitSpeechRecognition?:new()=>SpeechRecognizer;
 };
 const Recognizer=w.SpeechRecognition ?? w.webkitSpeechRecognition;
 return Recognizer?new Recognizer():null;
}

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
            if (block.type === "count" && typeof block.label === "string" &&
              typeof block.value === "number" && Number.isSafeInteger(block.value) && block.value >= 0) {
              const source = isRecord(block.source) ? block.source : null;
              return <div key={index} className="rounded-xl bg-[#F3F7F4] p-3">
                <p className="text-[17px] font-semibold text-ink">{block.label}</p>
                <p className="font-headline text-2xl font-bold text-ink">
                  {new Intl.NumberFormat().format(block.value)}
                </p>
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
  enabled, unavailableReason, locale, copy,
}: { enabled: boolean; unavailableReason: SupervisorChatUnavailableReason | null;
  locale: Locale; copy: SupervisorChatCopy }) {
  const [threads, setThreads] = useState<ConversationThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [voicePhase,setVoicePhase]=useState<"idle"|"starting"|"listening"|"processing"|"review"|"error">("idle");
  const [interimSpeech,setInterimSpeech]=useState("");
  const [uploading,setUploading]=useState(false);
  const [attachments,setAttachments]=useState<StoredAttachment[]>([]);
  const [mediaNotice,setMediaNotice]=useState("");
  const speech=useRef<SpeechRecognizer|null>(null);
  const speechSession=useRef<{base:string;final:string;failed:boolean}|null>(null);
  const filePicker=useRef<HTMLInputElement|null>(null);
  const retryId = useRef<string | null>(null);
  const threadRequestId = useRef<string | null>(null);

  useEffect(()=>()=>{speech.current?.stop();speech.current=null;speechSession.current=null;},[]);
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
    if (!enabled || !threadId || sending) return;
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
  }, [enabled, threadId, sending]);
  useEffect(()=>{
    if(!enabled || !threadId)return;
    const controller=new AbortController();
    void fetch("/api/ai/threads/"+encodeURIComponent(threadId)+"/attachments",{
      signal:controller.signal,cache:"no-store",
    }).then((response)=>jsonFrom<{items:StoredAttachment[]}>(response))
      .then(({items})=>{if(!controller.signal.aborted)setAttachments(items);})
      .catch(()=>{if(!controller.signal.aborted)setError(true);});
    return ()=>controller.abort();
  },[enabled,threadId]);

  async function refreshThreads() {
    const page = await jsonFrom<ConversationPage<ConversationThread>>(
      await fetch("/api/ai/threads", { cache: "no-store" }),
    );
    setThreads(page.items);
  }

  async function sendText(input: string) {
    const text = input.trim();
    if (!enabled || !text || sending || speech.current || text.length > 4000) return;
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

  async function ensureThread():Promise<string>{
    if(threadId)return threadId;
    threadRequestId.current ??= crypto.randomUUID();
    const created=await jsonFrom<{thread:ConversationThread}>(await fetch("/api/ai/threads",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({requestId:threadRequestId.current}),
    }));
    setThreadId(created.thread.id);
    threadRequestId.current=null;
    await refreshThreads();
    return created.thread.id;
  }

  function listen(){
    if(!enabled||sending||uploading)return;
    if(speech.current){
      if(voicePhase==="processing")return;
      setVoicePhase("processing");
      setMediaNotice("");
      speech.current.stop();
      return;
    }
    const recognition=recognitionForBrowser();
    if(!recognition){setVoicePhase("error");setMediaNotice(copy.voiceUnavailable);return;}
    speech.current=recognition;
    speechSession.current={base:draft,final:"",failed:false};
    setInterimSpeech("");
    setVoicePhase("starting");setMediaNotice("");
    recognition.lang=locale==="ar"?"ar":locale==="es"?"es-ES":"en-US";
    recognition.interimResults=true;
    recognition.onstart=()=>setVoicePhase("listening");
    recognition.onresult=(event)=>{
      const session=speechSession.current;
      if(!session)return;
      const chunks=speechChunks(event.results);
      if(chunks.final){
        session.final=chunks.final;
        setDraft(appendSpeech(session.base,chunks.final));
        retryId.current=null;
      }
      setInterimSpeech(chunks.interim);
    };
    recognition.onerror=()=>{
      if(speechSession.current)speechSession.current.failed=true;
      setInterimSpeech("");setVoicePhase("error");setMediaNotice(copy.voiceUnavailable);
    };
    recognition.onend=()=>{
      const session=speechSession.current;
      speech.current=null;speechSession.current=null;
      setInterimSpeech("");
      if(session?.failed)return;
      if(session?.final){
        setDraft(appendSpeech(session.base,session.final));
        setVoicePhase("review");setMediaNotice(copy.voiceReview);
      }else{
        setVoicePhase("idle");setMediaNotice(copy.voiceNoSpeech);
      }
    };
    try{recognition.start();}
    catch{
      speech.current=null;speechSession.current=null;
      setVoicePhase("error");setMediaNotice(copy.voiceUnavailable);
    }
  }

  async function attach(event:ChangeEvent<HTMLInputElement>){
    const file=event.target.files?.[0];
    event.target.value="";
    if(!file||!enabled||uploading||sending)return;
    if(file.size>2*1024*1024||file.size===0){setMediaNotice(copy.attachmentUpload);return;}
    setUploading(true);setError(false);
    try{
      const id=await ensureThread();
      const form=new FormData();form.append("file",file);
      const response=await fetch("/api/ai/threads/"+encodeURIComponent(id)+"/attachments",{
        method:"POST",body:form,
      });
      const result=await jsonFrom<{attachment:StoredAttachment}>(response);
      setAttachments((prev)=>[result.attachment,...prev]);
      setMediaNotice(copy.attachmentSaved);
    }catch{setError(true);setMediaNotice(copy.attachmentUpload);}
    finally{setUploading(false);}
  }

  function selectThread(id: string | null) {
    speech.current?.stop();speech.current=null;speechSession.current=null;
    setVoicePhase("idle");setInterimSpeech("");
    if (sending) return;
    setThreadId(id);
    setMessages([]);
    setAttachments([]);
    setMediaNotice("");
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

      {enabled && attachments.length>0 && <section aria-label={copy.addAttachment}
        className="mb-3 rounded-xl border border-[#D8C8B5] bg-white p-3">
        <p className="text-[17px] text-ink-muted">{copy.attachmentNotice}</p>
        <ul className="mt-2 space-y-2">{attachments.map((file)=>
          <li key={file.id} className="break-all text-[17px] text-ink">
            <a href={"/api/ai/threads/"+encodeURIComponent(threadId??"")+
              "/attachments/"+encodeURIComponent(file.id)}
              target="_blank" rel="noopener noreferrer" className="underline">{file.originalName}</a>
          </li>)}</ul>
      </section>}
      <form onSubmit={(event) => { event.preventDefault(); void sendText(draft); }}
        className="rounded-[24px] border border-[#D8C8B5] bg-card/95 p-2 shadow-[0_10px_30px_rgba(42,29,20,0.08)]">
        <div className="flex min-h-14 items-center gap-2" role="group" aria-label={copy.composerLabel}>
          <input ref={filePicker} type="file" className="sr-only"
            accept=".txt,.pdf,.jpg,.jpeg,.png,.webp,text/plain,application/pdf,image/jpeg,image/png,image/webp"
            onChange={(event)=>void attach(event)}/>
          <button type="button" disabled={!enabled||sending||uploading}
            onClick={()=>filePicker.current?.click()} aria-label={copy.addAttachment}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#F3ECE3] text-ink-muted disabled:cursor-not-allowed">
            <Plus aria-hidden="true" size={24} />
          </button>
          <label htmlFor="supervisor-home-composer" className="sr-only">{copy.askAnything}</label>
          <input id="supervisor-home-composer" type="text"
            value={draft} onChange={(event) => {
              setDraft(event.target.value); retryId.current = null;
              if(voicePhase==="review")setVoicePhase("idle");
            }}
            maxLength={4000} disabled={!enabled || sending}
            placeholder={copy.askAnything}
            className="min-w-0 flex-1 bg-transparent px-1 text-[17px] font-semibold text-ink outline-none placeholder:text-ink-muted disabled:cursor-not-allowed" />
          <button type="button" disabled={!enabled||sending||uploading||voicePhase==="processing"}
            onClick={listen}
            aria-label={speech.current ? copy.voiceStop : copy.voiceInput}
            aria-pressed={voicePhase==="listening"||voicePhase==="starting"}
            title={speech.current ? copy.voiceStop : copy.voiceInput}
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full
              transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
              disabled:cursor-not-allowed ${voicePhase==="listening"||voicePhase==="starting"
                ? "bg-[#BE3434] text-white ring-4 ring-[#F5CDCD] animate-pulse"
                : "bg-[#E8F1EE] text-good"}`}>
            {voicePhase==="listening"||voicePhase==="starting" ? <MicOff aria-hidden="true" size={22}/> :
              <Mic aria-hidden="true" size={22}/>}
          </button>
          <button type="submit" disabled={!enabled || sending || Boolean(speech.current) || !draft.trim()}
            aria-label={copy.sendMessage}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink text-paper disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            <Send aria-hidden="true" size={20} />
          </button>
        </div>
      </form>

      {(voicePhase==="starting"||voicePhase==="listening"||voicePhase==="processing"||voicePhase==="review") && (
        <div role="status" aria-live="polite"
          className={`mt-2 rounded-xl border p-3 text-[17px] font-semibold
            ${voicePhase==="starting"||voicePhase==="listening" ? "border-[#C85555] bg-[#FFF0F0] text-[#922121]"
              : "border-[#B3CFC0] bg-[#EDF7F1] text-ink"}`}>
          <span className="inline-flex items-center gap-2">
            {(voicePhase==="starting"||voicePhase==="listening") && (
              <span aria-hidden="true" className="h-3 w-3 animate-pulse rounded-full bg-[#BE3434]"/>)}
            {voicePhase==="starting" ? copy.voiceStarting :
              voicePhase==="listening" ? copy.listening+" "+copy.voiceStop :
              voicePhase==="processing" ? copy.voiceProcessing : copy.voiceReview}
          </span>
          {interimSpeech && <p className="mt-2 break-words font-normal text-ink">{interimSpeech}</p>}
        </div>
      )}
      <p role="status" aria-live="polite"
        className={enabled
          ? "mt-2 text-[15px] font-medium text-ink-muted"
          : "mt-2 rounded-xl border border-[#D8C8B5] bg-[#FFF8EF] p-3 text-[17px] font-semibold text-ink"}>
        {enabled ? copy.live :
          unavailableReason === "explicitly_disabled" ? copy.statusDisabled :
          unavailableReason === "supabase_unconfigured" ? copy.statusDatabase :
          unavailableReason === "server_writer_unconfigured" ? copy.statusWriter :
          unavailableReason === "owner_access_required" ? copy.statusOwner : copy.statusStorage}
      </p>
      <div role="status" aria-live="polite" className="mt-1 text-[17px] text-ink">
        {sending && copy.sending}
        {uploading && copy.attachmentUpload}
        {mediaNotice && <span className="block">{mediaNotice}</span>}
        {error && (enabled ? copy.retry : copy.unavailable)}
      </div>
      <div className="-mx-1 mt-3 flex snap-x gap-2 overflow-x-auto px-1 pb-1 md:flex-wrap" aria-label={copy.composerLabel}>
        {copy.suggestions.map((suggestion) => (
          <button key={suggestion} type="button" disabled={!enabled || sending || Boolean(speech.current)}
            onClick={() => { if (draft !== suggestion) retryId.current = null; setDraft(suggestion); void sendText(suggestion); }}
            className="min-h-12 shrink-0 snap-start rounded-full border border-[#D8C8B5] bg-card px-4 text-[17px] font-bold text-ink shadow-sm disabled:cursor-not-allowed disabled:opacity-70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
