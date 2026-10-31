"use client";

import { Suspense, useEffect, useLayoutEffect, useReducer, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { Clock3, History, Mic, Plus, Send, Sparkles, Square, ThumbsUp, ThumbsDown, X, AlertCircle, Paperclip, LoaderCircle, UsersRound, ArrowDown } from "lucide-react";
import { AgentAvatar } from "@/components/operations/AITeamCard";
import { parseAgentId } from "@/lib/operating/tasks";
import { Link } from "@/i18n/navigation";
import { formatCents } from "@/lib/calc";
import { nextDictationStage } from "@/lib/ai/conversations/dictationState";
import { audioExtensionForMime, parseTranscriptionResponse, voiceMessageForError,
  VoiceTranscriptionError } from "@/lib/ai/conversations/voiceClient";
import type { StoredAttachment } from "@/lib/ai/conversations/attachments";
import type { SupervisorChatUnavailableReason } from "@/lib/ai/conversations/readiness";
import type { ConversationMessage, ConversationPage, ConversationThread } from "@/lib/ai/conversations/contracts";
import { activeOwnerQuestionMessageId, clarifyCardState, beginOptimisticOwner, sendKey, visibleConversationMessages,
  hasInsertedHistoryPage, isTranscriptNearBottom, transcriptScrollTarget, isDuplicateLinkedExperimentCard } from "./supervisorChatBehavior";
import { ChatMarkdown, SourceLegend } from "./ChatMarkdown";
import FactSummary from "./FactSummary";
import SupervisorProposalCard from "./SupervisorProposalCard";
import InventoryApproveAll from "./InventoryApproveAll";
import {buildAgentSendBody} from "./agentSendBody";
import MemoryCard from "./MemoryCard";
import ClarifyCard from "./ClarifyCard";
import HowIGotThis from "./HowIGotThis";
import {resumeOwnerQuestion} from "@/lib/ownerFacts/resume";
import {explainLineSchema} from "@/lib/ai/agent/explain";
import {clarifyBlockSchema} from "@/lib/ai/conversations/contracts";
import ChatJobProgress from "./ChatJobProgress";
import { useAgentJobWatcher } from "./useAgentJobWatcher";
import { answeredOwnerMessageIds, chatExperienceCopy, failureLine, inFlightOwnerMessageIds, readSseFrames } from "./chatExperience";
import { isJobStepAgent, type AgentJobStep } from "@/lib/ai/agent/jobState";
import SupervisorExperiment from "./SupervisorExperiment";
import ChatStart, {type ChatStartData,type ChatStartCopy} from "./ChatStart";
import DeferredChatStart, {type HomeStartPayload} from "./DeferredChatStart";
import type {Period} from "@/lib/viewmodels/period";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import { groupReplyBlocks, originalReplyBlockIndex } from "./supervisorReplyPresentation";
import SavedEventsCard from "./SavedEventsCard";
import {openEventDayThread,eventContextFromTitle,eventOwnerMessage,eventThreadKey,type EventChatContext} from "./eventDayThread";
import {ownerQuestionSchema,pendingOwnerInputSchema}
  from "@/lib/ai/supervisor/ownerInput/contracts";

export type SupervisorChatCopy = {
  askAnything: string; newMessage: string; composerLabel: string; addAttachment: string; voiceInput: string; sendMessage: string; teamButton: string;
  comingSoon: string; suggestions: string[];
  live: string; threads: string; newThread: string; empty: string; loading: string; sending: string;
  statusAlexReading: string; statusLeoReading: string; statusOliviaReading: string;
  statusMayaReading: string; statusSupervisorReading: string; statusSupervisorAnswering: string;
  retry: string; unavailable: string; more: string; you: string; supervisor: string; source: string; sourceCafe: string; sourcePricing: string; sourceTasks: string; sourceRules: string; sourceVerified: string;
  listening: string; voiceReview: string; voiceUnavailable: string; voiceStop: string;
  voiceProcessing: string; voicePermissionDenied: string; voiceNoSpeech: string;
  voiceServiceUnavailable: string; voiceNetworkError: string; voiceTooLong: string;
  voiceError: string; voiceCanceled: string;
  attachmentSaved: string; attachmentNotice: string; attachmentUpload: string; photoRequest:string;
  statusDisabled: string; statusDatabase: string; statusWriter: string; statusOwner: string; statusStorage: string;
  emptyHeading: string; emptyIntro: string; historyTitle: string; closeHistory: string;
  startNewChat: string; reviewHint: string; taskOpen: string;
  needsYou: string; handled: string; watching: string;
  answerFailed: string; retryAnswer: string; todaySummary: string; unverified: string; provenanceOwner:string;provenanceEstimate:string;provenanceUnchecked:string;provenanceBreakEven:string;provenanceSalesGap:string;provenanceLegend:string;provenanceOverhead:string;
  ownerInputDismiss:string;ownerInputConfirm:string;ownerInputOther:string;ownerInputAnswer:string;
  clarifyOther:string;clarifySend:string;clarifyYouChose:string;clarifySkipped:string;clarifyOtherPlaceholder:string;clarifyFillError:string;clarifySaveError:string;clarifyCountSummary:string;clarifyPurchaseSummary:string;
  howIGotThis:string;howCalculated:string;explainMissing:string;removeEventContext:string;
  pricingLaborPrefix:string;pricingBillsPrefix:string;explainYouToldMe:string;explainEstimate:string;explainSold:string;
  explainMultiply:string;explainSum:string;explainDivide:string;explainRatio:string;explainProrate:string;explainSubtract:string;
  feedbackUp: string; feedbackDown: string; feedbackSaved: string; feedbackError: string;
  snapshotExpand: string; snapshotCollapse: string; recording: string; transcribing: string;
};
type Locale = "en" | "es" | "ar";
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
type SupervisorProgress = { agent: string; stage: string } | null;
/** "Alex is checking your pricing…" etc. Only "reading"/"answering" ever render;
 * "done"/"limited" arrive right as the real reply does, so the composer's own
 * final message takes over before either would be shown. */
function progressStatusText(copy: SupervisorChatCopy, status: SupervisorProgress): string | null {
  if (!status) return null;
  if (status.stage === "answering") return copy.statusSupervisorAnswering;
  if (status.stage !== "reading") return null;
  switch (status.agent) {
    case "alex": return copy.statusAlexReading;
    case "leo": return copy.statusLeoReading;
    case "olivia": return copy.statusOliviaReading;
    case "maya": return copy.statusMayaReading;
    default: return copy.statusSupervisorReading;
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function ReplyBlock({ block, copy, locale, threadId, unverified = [] }: { block: unknown; copy: SupervisorChatCopy; locale: Locale; threadId?:string; unverified?: {start:number;end:number;source?:'owner'|'estimate'|'unchecked';detail?:string}[] }) {
  if (!record(block)) return null;
  if(block.type==="proposal_card"&&typeof block.proposalId==="string"&&threadId)
    return <SupervisorProposalCard threadId={threadId} proposalId={block.proposalId} locale={locale}/>;
  if(block.type==="experiment_card"&&typeof block.proposalId==="string"&&threadId)
    return <SupervisorExperiment threadId={threadId} locale={locale}
      copy={{en,es,ar}[locale].SupervisorExperiment} initialProposalId={block.proposalId}/>;
  if(block.type==="memory_card"&&typeof block.ruleId==="string")
    return <MemoryCard ruleId={block.ruleId} locale={locale}/>;
  if ((block.type === "text" || block.type === "warning") && typeof block.text === "string") {
    return block.type === "warning"
      ? <p className="flex items-start gap-2 text-[17px] leading-relaxed text-ink-muted" role="note">
          <AlertCircle aria-hidden="true" size={18} className="mt-1 shrink-0" />{block.text}
        </p>
      : <ChatMarkdown text={block.text} locale={locale} unverified={unverified} labels={{owner:copy.provenanceOwner,estimate:copy.provenanceEstimate,unchecked:copy.provenanceUnchecked,breakEvenSales:copy.provenanceBreakEven,salesGap:copy.provenanceSalesGap,dailyOverhead:copy.provenanceOverhead}} showLegend={false} />;
  }
  if (block.type === "task_card" && typeof block.title === "string" && typeof block.agent === "string" &&
    typeof block.status === "string" && typeof block.href === "string" &&
    block.href.startsWith("/operations") && !block.href.startsWith("//")) {
    const statusText = block.status === "handled" ? copy.handled :
      block.status === "watching" ? copy.watching : copy.needsYou;
    return <Link href={block.href} className="block rounded-2xl border border-line bg-surface p-4 no-underline shadow-sm transition-colors hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="text-[13px] font-extrabold uppercase tracking-wide text-ink-muted">{block.agent}</span>
          <p className="mt-1 break-words text-[17px] font-bold text-ink">{block.title}</p>
          <span className="mt-2 inline-flex rounded-full bg-surface2 px-3 py-1 text-sm font-semibold text-ink">{statusText}</span>
        </div>
        <span className="shrink-0 text-[15px] font-bold text-good">{copy.taskOpen} ↗</span>
      </div>
    </Link>;
  }
  return null;
}

function isOwnerConfirmation(message:ConversationMessage){
  const state=pendingOwnerInputSchema.safeParse(message.grounding?.ownerInput);
  return state.success&&state.data.stage==="confirm";
}
function SupervisorMessage({ message, copy, locale, cafeCurrency, onOwnerResponse, onClarify, onFacts, clarifyState, clarifyChoice, disabled, linkedThreadId, linkedProposalId }: {
  message: ConversationMessage; copy: SupervisorChatCopy; locale: Locale; cafeCurrency:string|null;
  disabled:boolean;
  linkedThreadId?:string; linkedProposalId?:string;
  onClarify:(text:string)=>void;
  onFacts:(questionId:string,answers:{fieldKey:string;value:string}[])=>Promise<void>;
  clarifyState:"hidden"|"active"|"chosen"|"skipped";clarifyChoice:string|null;
  onOwnerResponse:(message:ConversationMessage,value:string,isOption:boolean,dismiss?:boolean)=>void;
}) {
  if (message.role === "owner") return <article className="ms-auto w-fit max-w-[80%] rounded-[22px] rounded-ee-md bg-accent-soft px-4 py-3 text-[17px] text-ink shadow-sm">
    <p className="whitespace-pre-wrap break-words">{message.text}</p>
  </article>;
  const originalBlocks=message.blocks??[];
  const proposalIds=originalBlocks.flatMap(block=>record(block)&&block.type==="proposal_card"&&typeof block.proposalId==="string"?[block.proposalId]:[]);
  const groups=groupReplyBlocks(originalBlocks);
  const rawMetadata=message.grounding?.agentMetadata;
  const metadata=record(rawMetadata)?rawMetadata:null;
  const rawSpans=Array.isArray(metadata?.unverified)?metadata.unverified.filter(record):[];
  const legendSources=rawSpans.map(v=>
    v.source==="owner"||v.source==="estimate"?v.source:"unchecked" as const);
  const provenanceLabels={owner:copy.provenanceOwner,estimate:copy.provenanceEstimate,
    unchecked:copy.provenanceUnchecked,breakEvenSales:copy.provenanceBreakEven,
    salesGap:copy.provenanceSalesGap,dailyOverhead:copy.provenanceOverhead};
  return <article className="w-full space-y-3">
    <div className="flex items-center gap-2 text-[15px] font-bold text-ink-muted">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-pos-soft text-good">
        <Sparkles size={17} aria-hidden="true" />
      </span>
      {copy.supervisor}
    </div>
    <div className="w-full space-y-3 ps-1">
      {proposalIds.length>1&&<InventoryApproveAll threadId={message.threadId} ids={proposalIds} locale={locale}/>}
      {groups.map((group,i)=>{
        if(group.kind==="facts")
          return <FactSummary key={i} blocks={group.blocks} locale={locale} sourceText={copy.source}/>;
        if(isDuplicateLinkedExperimentCard(group.block,message.threadId,linkedThreadId,linkedProposalId))
          return null;
        if(record(group.block)&&group.block.type==="how"&&Array.isArray(group.block.lines)){
          const lines=group.block.lines.slice(0,20).flatMap(line=>{
            const parsed=explainLineSchema.safeParse(line);
            return parsed.success?[parsed.data]:[];
          });
          return lines.length?<HowIGotThis key={i} lines={lines} locale={locale} copy={copy} currency={cafeCurrency}/>:null;
        }
        const clarify=clarifyBlockSchema.safeParse(group.block);
        if(clarify.success)return <ClarifyCard key={i} block={clarify.data} locale={locale} copy={copy}
          state={clarifyState} choice={clarifyChoice} disabled={disabled} onSend={onClarify} onFacts={onFacts}/>;
        const candidate=ownerQuestionSchema.safeParse(group.block);
        if (candidate.success) return <ReplyBlock key={i} block={{type:"text",text:candidate.data.title[locale]}} copy={copy} locale={locale}/>;
        const originalIndex=originalReplyBlockIndex(originalBlocks,group.block);
        const spans = rawSpans
          .filter(v => v.blockIndex === originalIndex && typeof v.start === "number" && typeof v.end === "number")
          .map(v=>({start:Number(v.start),end:Number(v.end),
            source:(v.source==="owner"||v.source==="estimate"?v.source:"unchecked") as "owner"|"estimate"|"unchecked",
            detail:typeof v.detail==="string"?v.detail:undefined}));
        return <ReplyBlock key={i} block={group.block} copy={copy} locale={locale} threadId={message.threadId} unverified={spans}/>;
      })}
      <SourceLegend sources={legendSources} labels={provenanceLabels} legendLabel={copy.provenanceLegend}/>
    </div>
  </article>;
}
function AnswerFeedback({message,copy}:{message:ConversationMessage;copy:SupervisorChatCopy}) {
  const [rating,setRating]=useState<"up"|"down"|null>(null);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState(false);
  const [comment,setComment]=useState("");
  async function send(value:"up"|"down") {
    setSaving(true);setError(false);
    try {
      const response=await fetch("/api/ai/threads/"+encodeURIComponent(message.threadId)+"/feedback",{
        method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",
        body:JSON.stringify({messageId:message.id,rating:value,comment:comment.trim()||undefined})});
      if(!response.ok)throw new Error("feedback_failed");
      setRating(value);
    }catch{setError(true);}finally{setSaving(false);}
  }
  return <div className="ps-1 text-[17px] leading-relaxed text-ink-muted">
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={()=>void send("up")} disabled={saving}
        aria-pressed={rating==="up"} className={`inline-flex min-h-12 items-center gap-1.5 rounded-lg px-2 text-[17px] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${rating==="up"?"bg-surface2 text-ink":""}`}>
        <ThumbsUp size={18} aria-hidden="true"/><span>{copy.feedbackUp}</span>
      </button>
      <button type="button" onClick={()=>void send("down")} disabled={saving}
        aria-pressed={rating==="down"} className={`inline-flex min-h-12 items-center gap-1.5 rounded-lg px-2 text-[17px] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${rating==="down"?"bg-surface2 text-ink":""}`}>
        <ThumbsDown size={18} aria-hidden="true"/><span>{copy.feedbackDown}</span>
      </button>
      {rating&&<span role="status">{copy.feedbackSaved}</span>}
    </div>
    {rating==="down"&&<textarea aria-label={copy.feedbackDown} value={comment} onChange={e=>setComment(e.target.value)}
      maxLength={1000} rows={2} className="mt-2 min-h-12 w-full rounded-lg border border-line p-3 text-[17px]"/>}
    {rating==="down"&&<button className="min-h-12 underline" onClick={()=>void send("down")} disabled={saving} type="button">{copy.feedbackSaved}</button>}
    {error&&<p role="alert">{copy.feedbackError}</p>}
  </div>;
}
export default function SupervisorChatComposer({
  enabled, canUseAi=true, locale, cafeCurrency, copy, languageSwitch, onActivityChange, initialThreadId, initialProposalId, chatStartData,chatStartCopy,chatStartPromise,boardPeriod,
}: {
  enabled: boolean; canUseAi?: boolean; unavailableReason: SupervisorChatUnavailableReason | null;
  locale: Locale; copy: SupervisorChatCopy; cafeCurrency:string|null;
  chatStartData?: ChatStartData;
  chatStartCopy?: Omit<ChatStartCopy,"suggestions">;
  chatStartPromise?: Promise<HomeStartPayload | null>;
  boardPeriod?: Period;
  initialThreadId?:string;initialProposalId?:string;
  languageSwitch?: React.ReactNode;
  onActivityChange?: (active: boolean) => void;
}) {
  const [threads, setThreads] = useState<ConversationThread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(initialThreadId??null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loadedThreadId,setLoadedThreadId]=useState<string|null>(null);
  const [startExpanded,setStartExpanded]=useState(false);
  const sendOnce=useRef(false);
  const pendingFollowUps=useRef(new Set<string>());
  const [optimisticOwner, setOptimisticOwner] = useState<{ id: string; text: string; clientMessageId: string } | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [progressStatus, setProgressStatus] = useState<SupervisorProgress>(null);
  const [streamedText, setStreamedText] = useState("");
  const [threadTitle, setThreadTitle] = useState<string | null>(null);
  const [eventContext,setEventContext]=useState<EventChatContext|null>(null);
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
  const prependAnchor = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const [prependVersion, setPrependVersion] = useState(0);
  const appliedPrependVersion = useRef(0);
  const paginationRequest = useRef(0);
  const selectedThreadId = useRef<string | null>(initialThreadId ?? null);
  const pinned = useRef(true);
  const openingThread = useRef(true);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const messageContent = useRef<HTMLDivElement | null>(null);
  const retryId = useRef<string | null>(null);
  const threadRequestId = useRef<string | null>(null);
  const eventThreadIds=useRef(new Map<string,string>());
  const openingEvent=useRef(false);
  // Background jobs: these stay empty/null unless the server sends an
  // "ack" event (for example when the jobs table is unavailable).
  const liveCopy = chatExperienceCopy(locale);
  const [liveJobId, setLiveJobId] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<AgentJobStep[]>([]);
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const [failureCode, setFailureCode] = useState<string | null>(null);
  const [queuedOwner, setQueuedOwner] = useState<{ id: string; text: string; clientMessageId: string }[]>([]);
  // Only client display state; no pending clarification stored or sent to the API.
  const [chosenClarify, setChosenClarify] = useState<Record<string,string>>({});
  const [reloadVersion, setReloadVersion] = useState(0);
  const watcher = useAgentJobWatcher(threadId, enabled && !sending, (job) => {
    setReloadVersion((v) => v + 1);
    if (job.status === "failed") { setFailureCode(job.errorCode ?? "agent_turn_failed"); setError(true); }
  });
  const resumedRunning = !sending && watcher.job?.status === "running";

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
        setMessages(page.items); setNextOffset(page.nextOffset);setLoadedThreadId(threadId);
        const title=threads.find((thread) => thread.id === threadId)?.title??null;
        setThreadTitle(title);
        setEventContext(current=>current?.threadId===threadId?current:
          title?eventContextFromTitle(title,threadId):null);
      }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [enabled, threadId, sending, threads, reloadVersion]);
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
  useLayoutEffect(() => { selectedThreadId.current = threadId; }, [threadId]);

  function scrollToLatest() {
    const node = transcript.current;
    if (!node) return;
    pinned.current = true;
    setShowNewMessage(false);
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
  }
  function onTranscriptScroll() {
    const node = transcript.current;
    if (!node) return;
    pinned.current = isTranscriptNearBottom(node);
    setShowNewMessage(!pinned.current);
  }
  useLayoutEffect(() => {
    const node = transcript.current;
    if (!node) return;
    if (openingThread.current && threadId && !messages.length && !sending) return;
    // Streaming updates may render while history is loading. Only consume the
    // saved anchor in the same commit that inserts that history page.
    const insertedHistory = hasInsertedHistoryPage(prependVersion, appliedPrependVersion.current);
    const anchor = insertedHistory ? prependAnchor.current : null;
    const target = transcriptScrollTarget({
      scrollTop: anchor?.scrollTop ?? node.scrollTop, scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
      previousScrollHeight: anchor?.scrollHeight ?? null,
      pinned: !insertedHistory && (openingThread.current || pinned.current),
    });
    if (target !== null) node.scrollTop = target;
    if (insertedHistory) {
      appliedPrependVersion.current = prependVersion;
      prependAnchor.current = null;
    }
    if (openingThread.current && messages.length) {
      openingThread.current = false;
      pinned.current = true;
      setShowNewMessage(false);
    }
  }, [messages, optimisticOwner, sending, streamedText, progressStatus, threadId, prependVersion]);

  useEffect(() => {
    const node = transcript.current;
    const content = messageContent.current;
    if (!node || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) scrollToLatest();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  async function refreshThreads() {
    const page = await jsonFrom<ConversationPage<ConversationThread>>(
      await fetch("/api/ai/threads", { cache: "no-store" }));
    setThreads(page.items);
    if (selectedThreadId.current) setThreadTitle(page.items.find((thread) => thread.id === selectedThreadId.current)?.title ?? null);
  }
  async function ensureThread(): Promise<string> {
    if (threadId) return threadId;
    threadRequestId.current ??= crypto.randomUUID();
    const created = await jsonFrom<{ thread: ConversationThread }>(await fetch("/api/ai/threads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: threadRequestId.current }),
    }));
    selectedThreadId.current = created.thread.id;
    setThreadId(created.thread.id); setThreadTitle(created.thread.title);
    threadRequestId.current = null;
    return created.thread.id;
  }
  async function agentErrorCode(response: Response): Promise<string> {
    try { const body = await response.json() as { error?: unknown }; return typeof body.error === "string" ? body.error : "agent_request_failed"; }
    catch { return "agent_request_failed"; }
  }
  /** Background jobs: a message sent while an answer is still being worked on joins
   * that same job; the server folds it into the answer or answers it right after. */
  async function sendFollowUp(text: string) {
    const id = threadId;
    if (!id || !enabled || !canUseAi || !text.trim() || text.length > 4000 || pendingFollowUps.current.has(text)) return;
    pendingFollowUps.current.add(text);
    const clientMessageId = crypto.randomUUID();
    setDraft(""); setFailureCode(null);
    setQueuedOwner((queue) => [...queue, { id: "queued-" + clientMessageId, text, clientMessageId }]);
    pinned.current = true;
    try {
      const response = await fetch("/api/ai/threads/" + encodeURIComponent(id) + "/agent", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(buildAgentSendBody(clientMessageId,text,locale,attachments)),
      });
      if (!response.ok || !response.body) throw new Error(await agentErrorCode(response));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const read = readSseFrames(buffer + decoder.decode(value, { stream: true }));
          buffer = read.rest;
          for (const frame of read.frames) {
            if (frame.type === "error") throw new Error(typeof frame.data.code === "string" ? frame.data.code : "agent_turn_failed");
            if (frame.type === "ack") setLiveNote(frame.data.mode === "started" ? liveCopy.answering : liveCopy.followUpQueued);
          }
        }
      } finally { reader.releaseLock(); }
      const page = await loadMessages(id);
      if (selectedThreadId.current === id) { setMessages(page.items); setNextOffset(page.nextOffset); }
      if (!sending) watcher.recheck();
    } catch (failure) {
      setDraft((current) => current || text);
      setFailureCode(failure instanceof Error ? failure.message : "agent_turn_failed");
    } finally {
      pendingFollowUps.current.delete(text);
      setQueuedOwner((queue) => queue.filter((item) => item.clientMessageId !== clientMessageId));
    }
  }
  async function sendText(value: string, existingKey?: string, targetThreadId?: string,
    attachmentOverride?:readonly StoredAttachment[]) {
    const inputText=value.trim() || (attachments.some(file=>file.mediaType.startsWith("image/"))?copy.photoRequest:"");
    const context=eventContext?.threadId===(targetThreadId??threadId)?eventContext:null;
    const text=eventOwnerMessage(inputText,context);
    // A confirmed background job accepts follow-ups while the first response streams.
    // The main-turn double-tap guard must not intercept this separate path.
    if (!targetThreadId && !existingKey && enabled && canUseAi && text && (sending ? Boolean(liveJobId) : resumedRunning) &&
      !uploading && !recorder.current && dictation !== "recognizing" && text.length <= 4000)
      return sendFollowUp(text);
    if(sendOnce.current)return;
    if (!enabled || !canUseAi || !text || sending || uploading || recorder.current || dictation === "recognizing" || text.length > 4000) return;
    sendOnce.current=true;
    const clientMessageId = sendKey(existingKey, retryId.current, () => crypto.randomUUID());
    retryId.current = clientMessageId;
    if (!existingKey) {
      // Optimistic view only: the server owns persistence and idempotency.
      setOptimisticOwner(beginOptimisticOwner(text, clientMessageId));
      pinned.current = true;
      openingThread.current = false;
      setShowNewMessage(false);
      setDraft("");
    }
    setSending(true); setError(false); setFailureCode(null); setProgressStatus(null); setStreamedText("");
    let attemptedThreadId: string | null = null;
    // Set once the server confirms a background job; from then on a dropped
    // connection is not a failure because the answer keeps being written.
    let jobConfirmed = false, serverError = false;
    try {
      const id = targetThreadId ?? await ensureThread();
      attemptedThreadId = id;
      const response = await fetch("/api/ai/threads/" + encodeURIComponent(id) + "/agent", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(buildAgentSendBody(clientMessageId,text,locale,attachmentOverride??attachments)),
      });
      if (!response.ok || !response.body) throw new Error("agent_request_failed");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", finished = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const read = readSseFrames(buffer + decoder.decode(value, { stream: true }));
          buffer = read.rest;
          for (const { type, data } of read.frames) {
            const event = data as { text?: string; code?: string; discardChars?: number; agentId?: string;
              name?: string; jobId?: string; mode?: string };
            if (type === "ack" && typeof event.jobId === "string") {
              jobConfirmed = true;
              setLiveJobId(event.jobId);
              if (event.mode === "continuation") {
                setStreamedText(""); setLiveSteps([]); setLiveNote(liveCopy.continuing);
              } else if (event.mode !== "started") {
                // Already running elsewhere (another tab, or a retry): hand over to the watcher.
                finished = true; setLiveNote(liveCopy.followUpQueued);
              }
            } else if (type === "tool" && (event.agentId === "alex" || event.agentId === "olivia" ||
              event.agentId === "maya" || event.agentId === "leo")) {
              setProgressStatus({agent:event.agentId,stage:"reading"});
              const stepTool = event.name, stepAgent = event.agentId;
              if (typeof stepTool === "string" && isJobStepAgent(stepAgent)) {
                const step: AgentJobStep = { tool: stepTool, agent: stepAgent };
                setLiveSteps((steps) => [...steps, step].slice(-12));
              }
            } else if (type === "followup") {
              setLiveNote(liveCopy.followUpRead);
            } else if (type === "delta" && typeof event.text === "string") {
              setStreamedText(current => current + event.text);
              setProgressStatus({ agent: "supervisor", stage: "answering" });
            } else if (type === "reset" && Number.isSafeInteger(event.discardChars) &&
              event.discardChars !== undefined && event.discardChars >= 0) {
              setStreamedText(current => current.slice(0, Math.max(0, current.length - event.discardChars!)));
            } else if (type === "error") {
              serverError = true;
              throw new Error(event.code ?? "agent_turn_failed");
            } else if (type === "done") {
              finished = true;
              if (jobConfirmed) {
                // A continuation may follow on this same stream; show this answer now.
                const page = await loadMessages(id);
                setMessages(page.items); setNextOffset(page.nextOffset);
                setOptimisticOwner(null); setStreamedText(""); setLiveNote(null);
              }
            }
          }
        }
      } finally { reader.releaseLock(); }
      if (!finished) throw new Error("agent_stream_incomplete");
      const page = await loadMessages(id);
      setMessages(page.items);
      setNextOffset(page.nextOffset);
      setOptimisticOwner(null);
      await refreshThreads();
      retryId.current = null; setStreamedText("");
      dispatchDictation({ type: "reset" }); setMediaNotice(""); setAttachments([]);
    } catch (failure) {
      if (existingKey) retryId.current = null;
      // Server may have persisted the owner turn before the response failed.
      if (attemptedThreadId) {
        try {
          const page = await loadMessages(attemptedThreadId);
          setMessages(page.items); setNextOffset(page.nextOffset);
        } catch { /* do not fabricate a durable turn */ }
      }
      if (jobConfirmed && !serverError) {
        // Connection dropped but the job keeps running: the watcher resumes it.
        setOptimisticOwner(null); retryId.current = null;
      } else {
        if (!existingKey) {
          setOptimisticOwner(null);
          setDraft(current=>current || inputText);
        }
        if (jobConfirmed) setFailureCode(failure instanceof Error ? failure.message : "agent_turn_failed");
        setError(true);
      }
    } finally {
      sendOnce.current=false;
      setSending(false); setProgressStatus(null); setStreamedText("");
      setLiveJobId(null); setLiveSteps([]); setLiveNote(null);
    }
  }
  async function loadOlder() {
    if (!threadId || nextOffset === null || loading) return;
    const requestedThread = threadId;
    const request = ++paginationRequest.current;
    // Older pages are loaded independently from SSE and can resolve in any
    // order. A different conversation must never receive an old page.
    pinned.current = false;
    setLoading(true);
    try {
      const page = await loadMessages(requestedThread, nextOffset);
      if (request !== paginationRequest.current || selectedThreadId.current !== requestedThread) return;
      const node = transcript.current;
      prependAnchor.current = node
        ? { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight }
        : null;
      setMessages((current) => {
        const known = new Set(current.map((msg) => msg.id));
        return [...page.items.filter((msg) => !known.has(msg.id)), ...current];
      });
      setNextOffset(page.nextOffset);
      // Batched with setMessages, so only this version authorizes consumption.
      setPrependVersion((version) => version + 1);
    } catch {
      if (request === paginationRequest.current && selectedThreadId.current === requestedThread) setError(true);
    } finally {
      if (request === paginationRequest.current) setLoading(false);
    }
  }
  function selectThread(id: string | null) {
    if (sending) return;
    cleanupRecording(); dispatchDictation({ type: "reset" });
    paginationRequest.current++;
    prependAnchor.current = null;
    selectedThreadId.current = id;
    setLoading(false);
    setThreadId(id); setMessages([]);setLoadedThreadId(null);setStartExpanded(false); setNextOffset(null); setAttachments([]);
    setOptimisticOwner(null);
    openingThread.current = Boolean(id); pinned.current = true;
    setShowNewMessage(false);
    const title=threads.find((thread) => thread.id === id)?.title??null;
    setThreadTitle(title);
    setEventContext(id&&title?eventContextFromTitle(title,id):null);
    setDraft(""); setMediaNotice(""); setError(false); setHistoryOpen(false);
    setFailureCode(null); setQueuedOwner([]);
    retryId.current = null; threadRequestId.current = null;
    composer.current?.focus();
  }
  async function transcribeAudio(blob: Blob, durationSeconds: number, generation: number) {
    try {
      const extension=audioExtensionForMime(blob.type);
      if(!extension)throw new VoiceTranscriptionError("audio_format_unsupported");
      const body = new FormData();
      body.append("audio", new File([blob], "dictation." + extension, { type: blob.type }));
      body.append("durationSeconds", String(durationSeconds));
      const response = await parseTranscriptionResponse(await fetch("/api/ai/transcribe", {
        method: "POST", credentials: "same-origin", body,
      }));
      if (recordingGeneration.current !== generation) return;
      const heard = response.text.trim();
      if (!heard) throw new VoiceTranscriptionError("audio_no_speech");
      setDraft((current) => ((current.trim() ? current.trimEnd() + " " : "") + heard).slice(0, 4000));
      retryId.current = null;
      dispatchDictation({ type: "result" }); setMediaNotice(copy.voiceReview);
      composer.current?.focus();
    } catch (issue) {
      if (recordingGeneration.current === generation) {
        const code=issue instanceof VoiceTranscriptionError?issue.code:"transcription_network";
        dispatchDictation({ type: "error" }); setMediaNotice(voiceMessageForError(code,copy));
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
    if (!enabled || !canUseAi || sending || uploading || dictation === "recognizing") return;
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
      const mimeType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg"]
        .find((candidate) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(candidate));
      // Safari may support a default recording container even when it cannot
      // advertise an explicit MIME. Let the browser select a valid audio type.
      const active = mimeType?new MediaRecorder(stream,{mimeType}):new MediaRecorder(stream);
      recorder.current = active; recordingStream.current = stream;
      audioChunks.current = []; recordingStartedAt.current = Date.now(); setElapsed(0);
      active.ondataavailable = (event) => { if (event.data.size) audioChunks.current.push(event.data); };
      active.onerror = () => { cleanupRecording(); dispatchDictation({ type: "error" }); setMediaNotice(copy.voiceError); };
      active.onstop = () => {
        if (recorder.current !== active) return;
        const durationSeconds = Math.max(0.1, (Date.now() - recordingStartedAt.current) / 1000);
        const chunks=[...audioChunks.current];
        const recordedType=(active.mimeType||chunks.find(chunk=>chunk.type)?.type||"")
          .split(";")[0].trim().toLowerCase();
        recorder.current = null;
        recordingStream.current?.getTracks().forEach((track) => track.stop());
        recordingStream.current = null; audioChunks.current = [];
        if (recordingLimit.current) clearTimeout(recordingLimit.current);
        recordingLimit.current = null;
        if (!recordedType || !audioExtensionForMime(recordedType)) {
          dispatchDictation({ type: "error" }); setMediaNotice(copy.voiceUnavailable); return;
        }
        const blob = new Blob(chunks, { type:recordedType });
        if (blob.size === 0) {
          dispatchDictation({ type: "error" }); setMediaNotice(copy.voiceNoSpeech); return;
        }
        if (blob.size > 8 * 1024 * 1024) {
          dispatchDictation({ type: "error" }); setMediaNotice(copy.voiceTooLong); return;
        }
        void transcribeAudio(blob, durationSeconds, generation);
      };
      active.start(250);
      dispatchDictation({ type: "start" }); setMediaNotice("");
      recordingLimit.current = setTimeout(() => stopRecording(), 45_000);
    } catch (issue) {
      stream?.getTracks().forEach((track) => track.stop());
      if (generation === recordingGeneration.current) {
        const denied=issue instanceof DOMException &&
          (issue.name==="NotAllowedError"||issue.name==="SecurityError");
        cleanupRecording();
        dispatchDictation({ type: "error" });
        setMediaNotice(denied?copy.voicePermissionDenied:copy.voiceUnavailable);
      }
    } finally {
      requestingMicrophone.current = false;
    }
  }
  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !enabled || !canUseAi || uploading || sending) return;
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
  const clarifyVisibilityMessages:ConversationMessage[]=[
    ...displayedMessages,...queuedOwner.map(o=>({
      ...o,threadId:threadId??"",role:"owner" as const,contentType:"text" as const,
      blocks:null,grounding:null,createdAt:new Date().toISOString(),
    })),
  ];
  const activeQuestionMessageId=activeOwnerQuestionMessageId(displayedMessages);
  const hasChatMessages=displayedMessages.length>0;
  const startReady=!threadId||loadedThreadId===threadId||hasChatMessages;
  const answeredOwnerIds = answeredOwnerMessageIds(messages);
  const inFlightOwnerIds = inFlightOwnerMessageIds(watcher.job);
  const pendingOwnerIds = new Set(!sending ? messages
    .filter((message) => message.role === "owner" && Boolean(message.clientMessageId) &&
      !answeredOwnerIds.has(message.id) && !inFlightOwnerIds.has(message.id))
    .map((message) => message.id) : []);
  const inputLocked = sending && !liveJobId;
  const shownFailure = failureCode ?? (watcher.job?.status === "failed" ? watcher.job.errorCode ?? null : null);
  const durationLabel = String(Math.floor(elapsed / 60)) + ":" + String(elapsed % 60).padStart(2, "0");
  // A tap on a saved event opens that day in the same Supervisor conversation.
  const boardAskDisabled = !enabled || !canUseAi || sending || uploading || dictation === "recognizing" || resumedRunning;
  const chatAboutEventDay=async(date:string,title:string,eventId?:string,existingThreadId?:string)=>{
    if(boardAskDisabled||openingEvent.current)return;
    openingEvent.current=true;
    try{
      // Existing plan threads represent a whole day, not one saved event.
      if(existingThreadId&&!eventId){
        eventThreadIds.current.set(eventThreadKey(date),existingThreadId);
        selectThread(existingThreadId);
        setEventContext({date,title,threadId:existingThreadId});
        return;
      }
      const chosenId=await openEventDayThread({
        date,title,eventId,known:eventThreadIds.current,
        create:async title=>{
          // Existing owner-scoped thread API handles idempotency and permissions.
          const created=await jsonFrom<{thread:ConversationThread}>(await fetch("/api/ai/threads",{
            method:"POST",headers:{"content-type":"application/json"},
            body:JSON.stringify({requestId:crypto.randomUUID(),title}),
          }));
          setThreads(current=>[created.thread,...current.filter(t=>t.id!==created.thread.id)]);
          return created.thread;
        },
        select:id=>selectThread(id),
      });
      setEventContext({date,title,eventId,threadId:chosenId});
    }catch{
      setError(true);setFailureCode("agent_request_failed");
    }finally{openingEvent.current=false;}
  };
  // Only saved event facts are read on Home; no paid search starts when opening the panel.
  const comingUpCard = enabled && canUseAi ? <SavedEventsCard locale={locale}
    compact={hasChatMessages&&!startExpanded}
    onChatAboutDay={(date,title,eventId,existingThreadId)=>void chatAboutEventDay(date,title,eventId,existingThreadId)} chatDisabled={boardAskDisabled}/> : undefined;

  return <section className="relative flex h-[calc(100dvh-11.5rem)] min-h-[360px] flex-col overflow-hidden rounded-[22px] border border-line bg-surface2 shadow-sm md:h-[calc(100dvh-8rem)]"
    aria-label={copy.composerLabel}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-surface/85 px-4 py-3 md:px-5">
      <button type="button" onClick={() => setHistoryOpen(true)} disabled={!enabled}
        aria-label={copy.historyTitle} title={copy.historyTitle}
        className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-xl text-ink hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
        <History size={22} aria-hidden="true" />
      </button>
      <h2 className="min-w-0 flex-1 truncate text-center text-[16px] font-bold text-ink">
        {threadTitle || copy.supervisor}
      </h2>
      <Link href="/operations" title={copy.teamButton} aria-label={copy.teamButton}
        className="inline-flex min-h-12 items-center gap-1 rounded-xl px-2 text-[14px] font-bold text-ink no-underline hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
        <UsersRound size={19} aria-hidden="true" /><span className="hidden sm:inline">{copy.teamButton}</span>
      </Link>
      <button type="button" onClick={() => selectThread(null)} disabled={!enabled || !canUseAi || sending}
        aria-label={copy.startNewChat} title={copy.startNewChat}
        className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-xl text-ink hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
        <Plus size={22} aria-hidden="true" />
      </button>
    </header>
    {chatStartPromise&&hasChatMessages&&<div className="max-h-[40dvh] shrink-0 overflow-y-auto md:max-h-[55dvh]">
      <Suspense key={boardPeriod} fallback={<p role="status" className="p-3 text-[17px] text-ink-muted">{copy.sending}</p>}>
        <DeferredChatStart promise={chatStartPromise} suggestions={copy.suggestions} failureText={copy.unverified}
          hasMessages expanded={startExpanded} onToggle={()=>setStartExpanded(v=>!v)}
          onSuggestion={()=>{}} suggestionsDisabled comingUp={comingUpCard}/>
      </Suspense>
    </div>}
    {!chatStartPromise&&chatStartData&&chatStartCopy&&hasChatMessages&&<div className="max-h-[40dvh] shrink-0 overflow-y-auto md:max-h-[55dvh]">
      <ChatStart data={chatStartData} copy={{...chatStartCopy,suggestions:copy.suggestions}}
        hasMessages expanded={startExpanded} onToggle={()=>setStartExpanded(v=>!v)}
        onSuggestion={()=>{}} suggestionsDisabled
        comingUp={comingUpCard}/>
    </div>}
    <div ref={transcript} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none] px-3 py-4 md:px-6 md:py-5"
      onScroll={onTranscriptScroll} role="log" aria-live="polite" aria-label={copy.threads}>
      <div ref={messageContent} className="flex min-h-full flex-col items-stretch justify-start gap-4">
      {chatStartPromise&&!hasChatMessages&&startReady&&
        <Suspense key={boardPeriod} fallback={<p role="status" className="p-3 text-[17px] text-ink-muted">{copy.sending}</p>}>
          <DeferredChatStart promise={chatStartPromise} suggestions={copy.suggestions} failureText={copy.unverified}
            hasMessages={false} expanded={false} onToggle={()=>{}}
            onSuggestion={prompt=>{retryId.current=null;void sendText(prompt);}}
            suggestionsDisabled={!enabled||!canUseAi||sending||uploading||dictation==="recognizing"||resumedRunning}
            unavailableMessage={!enabled ? copy.unavailable : undefined}
            comingUp={comingUpCard}/>
        </Suspense>}
      {!chatStartPromise&&chatStartData&&chatStartCopy&&!hasChatMessages&&startReady&&
        <ChatStart data={chatStartData} copy={{...chatStartCopy,suggestions:copy.suggestions}}
          hasMessages={false} expanded={false} onToggle={()=>{}}
          onSuggestion={prompt=>{retryId.current=null;void sendText(prompt);}}
          suggestionsDisabled={!enabled||!canUseAi||sending||uploading||dictation==="recognizing"||resumedRunning}
          unavailableMessage={!enabled ? copy.unavailable : undefined}
          comingUp={comingUpCard}/>}

      {!chatStartPromise&&!chatStartData&&!hasChatMessages&&<div className="mx-auto py-3 text-center">
        <h2 className="font-headline text-xl font-bold text-ink">{copy.emptyHeading}</h2>
        {!enabled&&<p className="text-[17px] text-ink-muted">{copy.unavailable}</p>}
      </div>}
      {nextOffset !== null && <button type="button" onClick={() => void loadOlder()} disabled={loading}
        className="mx-auto flex min-h-12 items-center gap-2 rounded-xl px-4 text-[15px] font-semibold text-ink underline hover:bg-surface2">
        <Clock3 size={18} aria-hidden="true" /> {copy.more}
      </button>}
      {displayedMessages.map((message,messageIndex) => <div key={message.id} data-client-message-id={message.role === "owner" ? message.clientMessageId ?? undefined : undefined} className="space-y-2">
        <SupervisorMessage message={message} copy={copy} locale={locale} cafeCurrency={cafeCurrency}
          linkedThreadId={threadId===initialThreadId?initialThreadId:undefined}
          linkedProposalId={threadId===initialThreadId?initialProposalId:undefined}
          clarifyState={chosenClarify[message.id]&&clarifyCardState(clarifyVisibilityMessages,messageIndex).state==="skipped"?
            "chosen":clarifyCardState(clarifyVisibilityMessages,messageIndex).state}
          clarifyChoice={chosenClarify[message.id]??clarifyCardState(clarifyVisibilityMessages,messageIndex).choice}
          onClarify={value=>{setChosenClarify(old=>({...old,[message.id]:value}));void sendText(value);}}
          onFacts={async(questionId,answers)=>{
            if(!threadId||message.threadId!==threadId)throw new Error("thread_unavailable");
            const response=await fetch("/api/ai/threads/"+encodeURIComponent(threadId)+"/owner-answer",{
              method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
              body:JSON.stringify({questionId,answers,locale})
            });
            if(!response.ok)throw new Error("owner_answer_save_failed");
            const result=await response.json() as {saved:boolean;writeThroughApplied:boolean};
            if(!result.saved)throw new Error("owner_answer_save_failed");
            const savedCopy=({en,es,ar}[locale]).OwnerQuestions;
            const responseText=result.writeThroughApplied?savedCopy.saved:savedCopy.savedBut;
            setChosenClarify(old=>({...old,[message.id]:responseText}));
            const pending=pendingOwnerInputSchema.safeParse(message.grounding?.ownerInput);
            const original=pending.success?pending.data.originalText:
              [...displayedMessages.slice(0,messageIndex)].reverse()
                .find(entry=>entry.role==="owner"&&entry.text?.trim())?.text??null;
            const card=(message.blocks??[]).map(block=>clarifyBlockSchema.safeParse(block))
              .find(parsed=>parsed.success&&parsed.data.kind==="facts"&&parsed.data.questionId===questionId);
            const fields=card?.success&&card.data.kind==="facts"?card.data.fields:[];
            const facts=answers.map(answer=>({
              label:fields.find(field=>field.key===answer.fieldKey)?.label??answer.fieldKey,
              value:answer.value
            }));
            await sendText(resumeOwnerQuestion(original,responseText,facts));
          }}
          disabled={sending||!enabled||!canUseAi||
          (message.role==="supervisor"&&message.id!==activeQuestionMessageId&&clarifyCardState(clarifyVisibilityMessages,messageIndex).state!=="active")}
          onOwnerResponse={(origin,value,isOption,dismiss=false)=>{
            if(sending||!enabled||!canUseAi||origin.id!==activeQuestionMessageId)return;
            const question=ownerQuestionSchema.safeParse((origin.blocks??[]).find(b=>
              typeof b==="object"&&b!==null&&"type" in b&&b.type==="owner_question"));
            if(!question.success)return;
            const pending=pendingOwnerInputSchema.safeParse(origin.grounding?.ownerInput);
            if(pending.success){
              const action=dismiss||pending.data.stage==="confirm"&&isOption&&value==="dismiss"?
                "dismiss":pending.data.stage==="confirm"&&isOption&&value==="confirm"?
                "confirm":"supply";
              if(pending.data.stage==="confirm"&&action==="supply")return;
              // The visible owner message uses the localized label, not the
              // canonical record UUID; the typed answer retains the exact ID.
              const displayValue=isOption&&question.data.input.kind==="options"?
                question.data.input.options.find(o=>o.id===value)?.label[locale]??value:value;
              void sendText(action==="dismiss"?copy.ownerInputDismiss:
                action==="confirm"?copy.ownerInputConfirm:displayValue);
              return;
            }
            // Existing known-record clarification remains a normal owner statement.
            if(!dismiss)void sendText(isOption&&question.data.input.kind==="options"?
              question.data.input.options.find(o=>o.id===value)?.label[locale]??value:value);
          }}/>
        {message.role==="supervisor"&&<AnswerFeedback message={message} copy={copy}/>}
        {pendingOwnerIds.has(message.id) && <div className="flex max-w-[94%] items-center gap-3 rounded-xl border border-line bg-warn-soft p-3 text-[15px] text-ink" role="alert">
          <AlertCircle size={18} aria-hidden="true" />
          <span className="flex-1">{shownFailure ? failureLine(shownFailure, liveCopy) : copy.answerFailed}</span>
          <button type="button" onClick={() => void sendText(message.text ?? "", message.clientMessageId ?? undefined)}
            disabled={!canUseAi} className="min-h-10 rounded-xl bg-accent px-3 font-bold text-on-accent disabled:opacity-50">{copy.retryAnswer}</button>
        </div>}
      </div>)}
      {queuedOwner.map((item) => <article key={item.id} className="ms-auto w-fit max-w-[80%] rounded-[22px] rounded-ee-md bg-accent-soft px-4 py-3 text-[17px] text-ink opacity-80 shadow-sm">
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
      </article>)}
      {(sending && liveJobId || resumedRunning) && <ChatJobProgress locale={locale} acknowledged
        steps={sending ? liveSteps : watcher.job?.progress ?? []}
        note={sending ? liveNote : liveCopy.resumed} />}
      {sending && streamedText && <article className="w-full space-y-3"><div className="flex items-center gap-2 text-[15px] font-bold text-ink-muted"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-pos-soft text-good"><Sparkles size={17} aria-hidden="true"/></span>{copy.supervisor}</div><ReplyBlock block={{type:"text",text:streamedText}} copy={copy} locale={locale}/></article>}
      {sending && <div className="flex items-center gap-3 text-[16px] text-ink-muted" role="status">
        {parseAgentId(progressStatus?.agent) ?
          <span className="shrink-0"><AgentAvatar agentId={parseAgentId(progressStatus?.agent)!} size="task" /></span> :
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-good motion-reduce:animate-none" />}
        {progressStatusText(copy, progressStatus) ?? copy.sending}
      </div>}
      </div>
    </div>
    {showNewMessage && <button type="button" onClick={scrollToLatest} className="absolute bottom-28 left-1/2 z-10 inline-flex min-h-12 -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-accent-text shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"><ArrowDown size={16} aria-hidden="true" />{copy.newMessage}</button>}
    {initialProposalId && initialThreadId && threadId === initialThreadId && <div className="max-h-[50dvh] shrink-0 overflow-y-auto" data-testid="experiment-deeplink">
      <SupervisorExperiment key={initialThreadId + ":" + initialProposalId}
        threadId={threadId} locale={locale} canUseAi={canUseAi}
        copy={{en,es,ar}[locale].SupervisorExperiment}
        initialProposalId={initialProposalId} refreshVersion={messages.length} />
    </div>}
    <div className="mt-auto shrink-0 border-t border-line bg-surface2 px-2 py-2 md:px-4">
      {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2" aria-label={copy.addAttachment}>
        {attachments.map((file) => <a key={file.id}
          href={"/api/ai/threads/" + encodeURIComponent(threadId ?? "") + "/attachments/" + encodeURIComponent(file.id)}
          target="_blank" rel="noopener noreferrer"
          className="inline-flex max-w-full min-h-10 items-center gap-2 rounded-xl bg-surface px-3 text-[14px] font-semibold text-ink underline">
          <Paperclip size={17} aria-hidden="true" /><span className="truncate">{file.originalName}</span>
        </a>)}
      </div>}
      {eventContext?.threadId===threadId&&
        <div role="status" className="mb-2 flex min-h-10 items-center gap-2 rounded-xl bg-accent-soft px-3 py-2 text-[15px] font-semibold text-ink">
          <span className="min-w-0 flex-1 break-words">@event {eventContext.title} · {eventContext.date}</span>
          <button type="button" onClick={()=>setEventContext(null)} aria-label={copy.removeEventContext}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
            <X size={18} aria-hidden="true"/>
          </button>
        </div>}
      <form onSubmit={(event) => { event.preventDefault(); void sendText(draft); }}
        className="flex items-end gap-1 rounded-[22px] border border-line bg-surface p-1.5 shadow-sm">
        <input ref={filePicker} type="file" className="sr-only"
          accept=".txt,.pdf,.jpg,.jpeg,.png,.webp,text/plain,application/pdf,image/jpeg,image/png,image/webp"
          onChange={(event) => void attach(event)} />
        <button type="button" onClick={() => filePicker.current?.click()}
          aria-label={copy.addAttachment} title={copy.addAttachment}
          disabled={!enabled || !canUseAi || sending || uploading || dictation === "listening" || dictation === "recognizing"}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-surface2 disabled:opacity-50">
          <Plus size={22} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => void listen()}
          aria-label={dictation === "listening" ? copy.voiceStop : copy.voiceInput}
          title={dictation === "listening" ? copy.voiceStop : copy.voiceInput}
          aria-pressed={dictation === "listening"}
          disabled={!enabled || !canUseAi || sending || uploading || dictation === "recognizing"}
          className={dictation === "listening"
            ? "flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-neg text-paper ring-2 ring-neg-soft animate-pulse motion-reduce:animate-none"
            : "flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-good hover:bg-pos-soft disabled:opacity-40"}>
          {dictation === "listening" ? <Square size={20} fill="currentColor" aria-hidden="true" />
            : dictation === "recognizing" ? <LoaderCircle size={21} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <Mic size={22} aria-hidden="true" />}
        </button>
        <label htmlFor="supervisor-home-composer" className="sr-only">{copy.askAnything}</label>
        <textarea id="supervisor-home-composer" ref={composer}
          rows={1} maxLength={4000} value={draft}
          onChange={(event) => { setDraft(event.target.value); retryId.current = null; }}
          onKeyDown={composerKey} disabled={!enabled || !canUseAi || inputLocked}
          placeholder={eventContext?.threadId===threadId?"@event "+eventContext.title+" · "+copy.askAnything:copy.askAnything}
          className="min-w-0 max-h-40 min-h-12 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-3 text-[17px] leading-6 text-ink outline-none placeholder:text-ink-muted disabled:opacity-50" />
        <button type="submit" aria-label={copy.sendMessage}
          disabled={!enabled || !canUseAi || inputLocked || !draft.trim() || dictation === "listening" || dictation === "recognizing"}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent shadow-sm hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40">
          <Send size={21} aria-hidden="true" />
        </button>
      </form>
      {dictation === "listening" && <p className="mt-1 text-sm font-bold text-neg" role="status">
        {copy.recording} {durationLabel} · {copy.voiceStop}
      </p>}
      {dictation === "recognizing" && <p className="mt-1 text-sm font-semibold text-ink-muted" role="status">
        {copy.transcribing}
      </p>}
      <div role="status" aria-live="polite" className="text-[14px] font-medium text-ink-muted">
        {failureCode && (!error || pendingOwnerIds.size === 0) ? failureLine(failureCode, liveCopy)
          : error && pendingOwnerIds.size === 0 ? copy.answerFailed : uploading ? copy.attachmentUpload
          : dictation === "error" || dictation === "ready" ? mediaNotice
            : mediaNotice === copy.attachmentSaved ? mediaNotice : ""}
      </div>
    </div>
    {historyOpen && <div className="absolute inset-0 z-30 flex" role="presentation">
      <button type="button" className="absolute inset-0 bg-fg/35" aria-label={copy.closeHistory}
        onClick={() => setHistoryOpen(false)} />
      <aside role="dialog" aria-modal="true" aria-label={copy.historyTitle}
        className="relative z-10 flex h-full w-[min(88%,360px)] flex-col border-e border-line bg-surface2 shadow-xl">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h2 className="flex items-center gap-2 font-headline text-xl font-bold text-ink">
            <History aria-hidden="true" size={22} />{copy.historyTitle}
          </h2>
          <button type="button" onClick={() => setHistoryOpen(false)}
            aria-label={copy.closeHistory}
            className="flex h-12 w-12 items-center justify-center rounded-xl text-ink hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
            <X size={24} aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1 space-y-1 overflow-y-auto p-3">
          <button type="button" onClick={() => selectThread(null)}
            className="flex min-h-12 w-full items-center gap-2 rounded-xl px-3 text-start text-[17px] font-bold text-good hover:bg-surface2">
            <Plus size={20} aria-hidden="true" /> {copy.startNewChat}
          </button>
          {threads.length === 0 && <p className="p-4 text-[16px] text-ink-muted">{copy.empty}</p>}
          {threads.map((thread) => <button key={thread.id} type="button"
            onClick={() => selectThread(thread.id)} disabled={sending}
            aria-current={threadId === thread.id ? "page" : undefined}
            className={"flex min-h-14 w-full flex-col justify-center gap-1 rounded-xl px-3 py-2 text-start hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink " +
              (threadId === thread.id ? "bg-pos-soft" : "")}>
            <span className="line-clamp-2 text-[16px] font-semibold text-ink">{thread.title || copy.newThread}</span>
            <span className="text-[13px] text-ink-muted">
              {new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(thread.lastMessageAt ?? thread.createdAt))}
            </span>
          </button>)}
        </div>
        {languageSwitch && <div className="shrink-0 border-t border-line px-5 py-3 md:hidden">
          {languageSwitch}
        </div>}
      </aside>
    </div>}
  </section>;
}
