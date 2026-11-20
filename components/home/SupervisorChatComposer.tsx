"use client";

import { Suspense, useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, useSyncExternalStore, type ChangeEvent, type KeyboardEvent } from "react";
import { Clock3, Menu, ListChecks, Mic, Plus, Camera, ArrowUp, Sparkles, Square, SquarePen, ThumbsUp, ThumbsDown, X, AlertCircle, Paperclip, LoaderCircle, UsersRound, ArrowDown } from "lucide-react";
import { AgentAvatar } from "@/components/operations/AITeamCard";
import { parseAgentId } from "@/lib/operating/tasks";
import { Link } from "@/i18n/navigation";
import { NAV_TABS } from "@/components/shared/navTabs";
import { nextDictationStage } from "@/lib/ai/conversations/dictationState";
import { audioExtensionForMime, parseTranscriptionResponse, voiceMessageForError,
  VoiceTranscriptionError } from "@/lib/ai/conversations/voiceClient";
import type { StoredAttachment } from "@/lib/ai/conversations/attachments";
import type { SupervisorChatUnavailableReason } from "@/lib/ai/conversations/readiness";
import type { ConversationMessage, ConversationPage, ConversationThread } from "@/lib/ai/conversations/contracts";
import { activeOwnerQuestionMessageId, clarifyCardState, beginOptimisticOwner, sendKey, visibleConversationMessages,
  hasInsertedHistoryPage, isTranscriptNearBottom, transcriptScrollTarget, isDuplicateLinkedExperimentCard, mergeLatestConversationPage, loadedSavedReports, conversationLocation } from "./supervisorChatBehavior";
import { ChatMarkdown, SourceLegend } from "./ChatMarkdown";
import dynamic from "next/dynamic";
const SupervisorRichPresentation=dynamic(()=>import("./SupervisorRichPresentation"));
import FactSummary from "./FactSummary";
import SupervisorProposalCard from "./SupervisorProposalCard";
import InventoryApproveAll from "./InventoryApproveAll";
import {buildAgentSendBody} from "./agentSendBody";
import MemoryCard from "./MemoryCard";
import ClarifyCard from "./ClarifyCard";
import HowIGotThis from "./HowIGotThis";
import {resumeOwnerQuestion,ownerAnswerAcknowledgement} from "@/lib/ownerFacts/resume";
import {explainLineSchema} from "@/lib/ai/agent/explain";
import {clarifyBlockSchema} from "@/lib/ai/conversations/contracts";
import ChatJobProgress, { CafeActivity } from "./ChatJobProgress";
import SupervisorWorkStatus from "./SupervisorWorkStatus";
import SupervisorMandatePanel from "./SupervisorMandatePanel";
import { useSupervisorWork } from "./useSupervisorWork";
import type {OwnerWorkItem} from "@/lib/ai/supervisor/runs/ownerWorkView";
import { useAgentJobWatcher } from "./useAgentJobWatcher";
import { answeredOwnerMessageIds, shouldShowRunningJob, chatExperienceCopy, failureLine, inFlightOwnerMessageIds, readSseFrames } from "./chatExperience";
import { isJobStepAgent, type AgentJobStep } from "@/lib/ai/agent/jobState";
import SupervisorExperiment from "./SupervisorExperiment";
import ChatStart, {SupervisorWelcome,type ChatStartData,type ChatStartCopy} from "./ChatStart";
import DeferredChatStart, {type HomeStartPayload} from "./DeferredChatStart";
import type {Period} from "@/lib/viewmodels/period";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import ar from "@/messages/ar.json";
import { groupReplyBlocks, joinedAgentTextSpans, originalReplyBlockIndex } from "./supervisorReplyPresentation";
import SavedEventsCard from "./SavedEventsCard";
import {openEventDayThread,eventContextFromTitle,eventOwnerMessage,eventThreadKey,eventThreadFromHistory,type EventChatContext} from "./eventDayThread";
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
function subscribeConnectivity(notify:()=>void){
  window.addEventListener("online",notify);window.addEventListener("offline",notify);
  return()=>{window.removeEventListener("online",notify);window.removeEventListener("offline",notify);};
}
const readOffline=()=>!navigator.onLine;
const serverOffline=()=>false;

class ConversationReadError extends Error {
  constructor(readonly status:number){super("conversation_request_failed");}
}
async function jsonFrom<T>(response: Response): Promise<T> {
  if (!response.ok) throw new ConversationReadError(response.status);
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
    return <div data-work-proposal={block.proposalId} tabIndex={-1}><SupervisorProposalCard threadId={threadId} proposalId={block.proposalId} locale={locale}/></div>;
  if(block.type==="experiment_card"&&typeof block.proposalId==="string"&&threadId)
    return <div data-work-proposal={block.proposalId} tabIndex={-1}><SupervisorExperiment threadId={threadId} locale={locale}
      copy={{en,es,ar}[locale].SupervisorExperiment} initialProposalId={block.proposalId}/></div>;
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
function SupervisorMessage({ message, copy, locale, cafeCurrency, storedFiles, onOwnerResponse, onClarify, onFacts, onSuggest, suggestionsDisabled, clarifyState, clarifyChoice, disabled, linkedThreadId, linkedProposalId }: {
  message: ConversationMessage; copy: SupervisorChatCopy; locale: Locale; cafeCurrency:string|null;
  storedFiles?:{threadId:string;items:StoredAttachment[]}|null;
  disabled:boolean;
  linkedThreadId?:string; linkedProposalId?:string;
  onClarify:(text:string)=>void;
  onSuggest:(text:string)=>void;
  suggestionsDisabled:boolean;
  onFacts:(questionId:string,answers:{fieldKey:string;value:string;forget?:boolean}[])=>Promise<void>;
  clarifyState:"hidden"|"active"|"chosen"|"skipped";clarifyChoice:string|null;
  onOwnerResponse:(message:ConversationMessage,value:string,isOption:boolean,dismiss?:boolean)=>void;
}) {
  if (message.role === "owner") return <article className="ms-auto w-fit max-w-[80%] rounded-2xl bg-surface2 px-4 py-3 text-[17px] leading-relaxed text-ink">
    <p className="whitespace-pre-wrap break-words">{message.text}</p>
  </article>;
  const originalBlocks=message.blocks??[];
  const proposalIds=originalBlocks.flatMap(block=>record(block)&&block.type==="proposal_card"&&typeof block.proposalId==="string"?[block.proposalId]:[]);
  const rawMetadata=message.grounding?.agentMetadata;
  const metadata=record(rawMetadata)?rawMetadata:null;
  const groups=groupReplyBlocks(originalBlocks,typeof metadata?.endReason==="string");
  const rawSpans=Array.isArray(metadata?.unverified)?metadata.unverified.filter(record):[];
  const legendSources=rawSpans.map(v=>
    v.source==="owner"||v.source==="estimate"?v.source:"unchecked" as const);
  const provenanceLabels={owner:copy.provenanceOwner,estimate:copy.provenanceEstimate,
    unchecked:copy.provenanceUnchecked,breakEvenSales:copy.provenanceBreakEven,
    salesGap:copy.provenanceSalesGap,dailyOverhead:copy.provenanceOverhead};
  return <article className="w-full space-y-3">
    <div className="flex items-center gap-2 text-[15px] font-medium text-ink-muted">
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-pos-soft text-good">
        <Sparkles size={17} aria-hidden="true" />
      </span>
      {copy.supervisor}
    </div>
    <div className="w-full min-w-0 space-y-3">
      {proposalIds.length>1&&<InventoryApproveAll threadId={message.threadId} ids={proposalIds} locale={locale}/>}
      {groups.map((group,i)=>{
        if(group.kind==="facts")
          return <FactSummary key={i} blocks={group.blocks} locale={locale} sourceText={copy.source} cafeCurrency={cafeCurrency}/>;
        if(group.kind==="agentText")
          return <ChatMarkdown key={i} text={group.text} locale={locale} unverified={joinedAgentTextSpans(group,rawSpans)} labels={provenanceLabels} showLegend={false}/>;
        if(isDuplicateLinkedExperimentCard(group.block,message.threadId,linkedThreadId,linkedProposalId))
          return null;
        if(record(group.block)&&group.block.type==="rich_presentation")return <SupervisorRichPresentation key={i} block={group.block} message={message} attachments={storedFiles} locale={locale} onSuggest={onSuggest} disabled={suggestionsDisabled}/>;
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
  enabled, canUseAi=true, locale, cafeCurrency, copy, languageSwitch, onActivityChange, initialThreadId, initialProposalId, initialNewChat=false, chatStartData,chatStartCopy,chatStartPromise,boardPeriod,
}: {
  enabled: boolean; canUseAi?: boolean; unavailableReason: SupervisorChatUnavailableReason | null;
  locale: Locale; copy: SupervisorChatCopy; cafeCurrency:string|null;
  chatStartData?: ChatStartData;
  chatStartCopy?: Omit<ChatStartCopy,"suggestions">;
  chatStartPromise?: Promise<HomeStartPayload | null>;
  boardPeriod?: Period;
  initialThreadId?:string;initialProposalId?:string;initialNewChat?:boolean;
  languageSwitch?: React.ReactNode;
  onActivityChange?: (active: boolean) => void;
}) {
  const [threads, setThreads] = useState<ConversationThread[]>([]);
  const [threadsNextOffset,setThreadsNextOffset]=useState<number|null>(null);
  const selectedHistoryTitle=useRef<{id:string;title:string|null}|null>(null);
  const [threadId, setThreadId] = useState<string | null>(initialThreadId??null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loadedThreadId,setLoadedThreadId]=useState<string|null>(null);
  const [startExpanded,setStartExpanded]=useState(false);
  const sendOnce=useRef(false);
  const pendingFollowUps=useRef(new Set<string>());
  const [optimisticOwner, setOptimisticOwner] = useState<{ id: string; text: string; clientMessageId: string } | null>(null);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const messagePage=useRef<ConversationPage<ConversationMessage>>({items:[],nextOffset:null});
  useLayoutEffect(()=>{messagePage.current={items:messages,nextOffset};},[messages,nextOffset]);
  const [controlsTab,setControlsTab]=useState<"work"|"library"|"permissions"|null>(null);
  const controlsOpen=controlsTab!==null;
  const [workTarget,setWorkTarget]=useState<{threadId:string;proposalId?:string|null;messageId?:string|null}|null>(null);
  const [workNotice,setWorkNotice]=useState("");
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState("");
  const [sessionDenied,setSessionDenied]=useState(false);
  const [deniedThread,setDeniedThread]=useState<string|null>(null);
  const offline=useSyncExternalStore(subscribeConnectivity,readOffline,serverOffline);
  const explicitNewChat=useRef(initialNewChat&&!initialThreadId);
  const threadDrafts=useRef(new Map<string,{text:string;key:string|null;response:{key:string;response:import("@/lib/ai/supervisor/ownerInput/contracts").OwnerInputResponse}|null;fileIds:string[]}>());
  const pendingFileSelection=useRef<{threadId:string;ids:string[]}|null>(null);
  const [restoringFiles,setRestoringFiles]=useState(false);
  const [attachmentMenu,setAttachmentMenu]=useState(false);
  const [sending, setSending] = useState(false);
  const [progressStatus, setProgressStatus] = useState<SupervisorProgress>(null);
  const [streamedText, setStreamedText] = useState("");
  const [threadTitle, setThreadTitle] = useState<string | null>(null);
  const [eventContext,setEventContext]=useState<EventChatContext|null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [dictation, dispatchDictation] = useReducer(nextDictationStage, "idle");
  const [uploading, setUploading] = useState(false);
  // Only explicitly chosen attachments belong to the current owner turn.
  const [attachments, setAttachments] = useState<StoredAttachment[]>([]);
  const [storedAttachments, setStoredAttachments] =
    useState<{threadId:string;items:StoredAttachment[]}|null>(null);
  // AGENTS.md ships new UI copy in English only until translations are approved.
  const fileCopy={
    recent:"Previous files",reuse:"Use",remove:"Remove",
    tooLarge:"File too large (8 MB for photos, 2 MB for documents).",
    limit:"Choose up to three files per message.",failed:"File upload failed."
  };
  const [mediaNotice, setMediaNotice] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const recordingStream = useRef<MediaStream | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const recordingStartedAt = useRef(0);
  const recordingGeneration = useRef(0);
  const requestingMicrophone = useRef(false);
  const recordingLimit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filePicker = useRef<HTMLInputElement | null>(null);
  const attachmentTrigger=useRef<HTMLButtonElement|null>(null);
  const attachmentFirstChoice=useRef<HTMLButtonElement|null>(null);
  useEffect(()=>{if(attachmentMenu)attachmentFirstChoice.current?.focus();},[attachmentMenu]);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const shell = useRef<HTMLElement | null>(null);
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
  const retryResponse=useRef<{key:string;response:import("@/lib/ai/supervisor/ownerInput/contracts").OwnerInputResponse}|null>(null);
  const [acceptedDurableIds,setAcceptedDurableIds]=useState<string[]>([]);
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
  const watcher = useAgentJobWatcher(threadId, enabled && !sessionDenied && !sending, (job) => {
    setReloadVersion((v) => v + 1);
    if (job.status === "failed") { setFailureCode(job.errorCode ?? "agent_turn_failed"); setError(true); }
  });
  const supervisorWork = useSupervisorWork(threadId, Boolean(threadId)&&!sessionDenied);
  const durableWork=supervisorWork.items.filter(item=>item.executionVersion===2||item.kind==="investigation");
  const activeDurableQuestions=new Set(durableWork.flatMap(item=>item.questionId?[item.questionId]:[]));
  const durableSignature=JSON.stringify(durableWork.map(item=>[item.id,item.status,item.questionId,item.proof?.ref,item.relatedOwnerMessageIds]));
  const resumedRunning = !sending && shouldShowRunningJob(watcher.job,messages);

  const applyLatestPage=useCallback((fresh:ConversationPage<ConversationMessage>)=>{
    const previous=messagePage.current;
    const merged=mergeLatestConversationPage(previous,fresh);
    // An unrelated/nonoverlapping page invalidates an old in-flight offset.
    if(previous.items.length&&fresh.items.length&&!previous.items.some(m=>m.id===fresh.items[0].id)){
      paginationRequest.current++;setLoading(false);prependAnchor.current=null;
    }
    messagePage.current=merged;setMessages(merged.items);setNextOffset(merged.nextOffset);
  },[]);
  const clearDeniedSession=useCallback(()=>{
    // A failed owner authorization must not leave previously read chat/files visible.
    threadDrafts.current.clear();pendingFileSelection.current=null;setRestoringFiles(false);retryId.current=null;retryResponse.current=null;
    messagePage.current={items:[],nextOffset:null};paginationRequest.current++;selectedThreadId.current=null;
    setThreadId(null);setNextOffset(null);setSessionDenied(true);setThreads([]);setThreadsNextOffset(null);setMessages([]);setStoredAttachments(null);setAttachments([]);setDraft("");setControlsTab(null);setAttachmentMenu(false);
    setOptimisticOwner(null);setQueuedOwner([]);setLoadedThreadId(null);setThreadTitle(null);setEventContext(null);
  },[]);

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
    if (!enabled||sessionDenied) {
      threadDrafts.current.clear();
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
  }, [enabled,sessionDenied]);
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
  // iOS and some Android browsers resize the visual viewport, not the layout viewport.
  // Only react to actual keyboard contraction while the composer is focused.
  useEffect(() => {
    const node=shell.current, viewport=window.visualViewport;
    if(!node||!viewport)return;
    const sync=()=>{
      const contracted=document.activeElement===composer.current&&window.innerHeight-viewport.height>120;
      if(contracted){node.dataset.keyboard="open";node.style.setProperty("--supervisor-keyboard-height",`${Math.round(viewport.height)}px`);}
      else {delete node.dataset.keyboard;node.style.removeProperty("--supervisor-keyboard-height");}
    };
    viewport.addEventListener("resize",sync);
    document.addEventListener("focusin",sync);document.addEventListener("focusout",sync);
    return()=>{viewport.removeEventListener("resize",sync);document.removeEventListener("focusin",sync);document.removeEventListener("focusout",sync);delete node.dataset.keyboard;node.style.removeProperty("--supervisor-keyboard-height");};
  },[]);
  useEffect(() => {
    if (!enabled||sessionDenied) return;
    const controller = new AbortController();
    void fetch("/api/ai/threads", { signal: controller.signal, cache: "no-store" })
      .then((res) => jsonFrom<ConversationPage<ConversationThread>>(res))
      .then((page) => { if (!controller.signal.aborted) { setThreads(page.items);setThreadsNextOffset(page.nextOffset); if (page.items.length&&!explicitNewChat.current) setThreadId((current) => current ?? page.items[0].id); } })
      .catch(error => { if (!controller.signal.aborted) {if(error instanceof ConversationReadError&&[401,403].includes(error.status))clearDeniedSession();else setError(true);} });
    return () => controller.abort();
  }, [enabled,sessionDenied,clearDeniedSession]);
  // WhatsApp and other browser tabs append to the same stored conversation.
  // Refresh only when idle: never replace an active stream, a typed draft,
  // an optimistic owner turn, or the selected thread with a different thread.
  useEffect(() => {
    if (!enabled||sessionDenied) return;
    let stopped = false, checking = false;
    const controller = new AbortController();
    const refreshExternal = async () => {
      // Protect older-page navigation only after the target conversation has loaded.
      // Failed initial reads must still recover via focus/online/periodic refresh.
      if (stopped || checking || sending || !navigator.onLine || (workTarget && loadedThreadId === workTarget.threadId) || document.visibilityState === "hidden") return;
      checking = true;
      const selected = selectedThreadId.current;
      try {
        const page = await jsonFrom<ConversationPage<ConversationThread>>(await fetch("/api/ai/threads", {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        }));
        if (stopped || controller.signal.aborted) return;
        setThreads(page.items);setThreadsNextOffset(page.nextOffset);
        // The linked WhatsApp thread may be recent while the owner is viewing
        // a different web thread. Refresh only the selected thread's messages.
        if (selected && selectedThreadId.current === selected)
          setReloadVersion(v => v + 1);
        else if (!selected && page.items.length&&!explicitNewChat.current)
          setThreadId(current => current ?? page.items[0].id);
      } catch(error) {
        if(!stopped&&!controller.signal.aborted&&error instanceof ConversationReadError&&[401,403].includes(error.status))clearDeniedSession();
        // Offline/focus race: existing messages and draft remain intact.
      } finally { checking = false; }
    };
    const onFocus = () => { void refreshExternal(); };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshExternal();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => { void refreshExternal(); }, 25_000);
    return () => {
      stopped = true; controller.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, sessionDenied, sending, workTarget, loadedThreadId,clearDeniedSession]);
  useEffect(() => {
    if (!enabled || sessionDenied || !threadId || sending) return;
    const controller = new AbortController();
    void fetch("/api/ai/threads/" + encodeURIComponent(threadId) + "/messages?offset=0",
      { signal: controller.signal, cache: "no-store" })
      .then((res) => jsonFrom<ConversationPage<ConversationMessage>>(res))
      .then((page) => {
        if (controller.signal.aborted) return;
        applyLatestPage(page);setLoadedThreadId(threadId);setDeniedThread(null);
        const title=threads.find((thread) => thread.id === threadId)?.title??(selectedHistoryTitle.current?.id===threadId?selectedHistoryTitle.current.title:null);
        setThreadTitle(title);
        setEventContext(current=>current?.threadId===threadId?current:
          title?eventContextFromTitle(title,threadId):null);
      }).catch(error => { if (!controller.signal.aborted) {
        if(error instanceof ConversationReadError&&error.status===401)clearDeniedSession();
        else if(error instanceof ConversationReadError&&[403,404].includes(error.status)){
          // The selected thread is unavailable, not evidence of an empty conversation.
          threadDrafts.current.delete(threadId);messagePage.current={items:[],nextOffset:null};setDeniedThread(threadId);setNextOffset(null);setMessages([]);setStoredAttachments(null);setAttachments([]);setDraft("");setThreadTitle(null);setEventContext(null);retryId.current=null;retryResponse.current=null;setLoadedThreadId(null);setError(true);
        }else setError(true);
      } });
    return () => controller.abort();
  }, [enabled, sessionDenied, threadId, sending, threads, reloadVersion,durableSignature,clearDeniedSession,applyLatestPage]);
  useEffect(() => {
    if (!enabled || sessionDenied || !threadId || sending) return;
    const controller = new AbortController();
    void fetch("/api/ai/threads/" + encodeURIComponent(threadId) + "/attachments",
      { signal: controller.signal, cache: "no-store" })
      .then((res) => jsonFrom<{ items: StoredAttachment[] }>(res))
      .then((page) => { if (!controller.signal.aborted){
        setStoredAttachments({threadId,items:page.items});
        const selection=pendingFileSelection.current;
        if(selection?.threadId===threadId){
          const verified=selection.ids.flatMap(id=>page.items.find(file=>file.id===id)??[]);
          setAttachments(verified);pendingFileSelection.current=null;setRestoringFiles(false);
          if(verified.length!==selection.ids.length)setMediaNotice(en.SupervisorExperience.filesUnverified);
        }
      } })
      .catch(error => { if (!controller.signal.aborted) {if(error instanceof ConversationReadError&&error.status===401)clearDeniedSession();else {if(error instanceof ConversationReadError&&[403,404].includes(error.status)){setStoredAttachments(null);setAttachments([]);pendingFileSelection.current=null;setRestoringFiles(false);}setError(true);}} });
    return () => controller.abort();
  }, [enabled, sessionDenied, threadId, sending, reloadVersion,clearDeniedSession]);
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
    setThreads(page.items);setThreadsNextOffset(page.nextOffset);
    if (selectedThreadId.current) setThreadTitle(page.items.find((thread) => thread.id === selectedThreadId.current)?.title ?? (selectedHistoryTitle.current?.id===selectedThreadId.current?selectedHistoryTitle.current.title:null));
  }
  async function ensureThread(): Promise<string> {
    if (threadId) return threadId;
    threadRequestId.current ??= crypto.randomUUID();
    const created = await jsonFrom<{ thread: ConversationThread }>(await fetch("/api/ai/threads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: threadRequestId.current }),
    }));
    explicitNewChat.current=false;
    selectedThreadId.current = created.thread.id;
    window.history.replaceState(null,"",conversationLocation(window.location.href,created.thread.id));
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
    if (!navigator.onLine||!id || !enabled || !canUseAi || !text.trim() || text.length > 4000 || pendingFollowUps.current.has(text)) return;
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
      if(response.status===401){clearDeniedSession();return;}
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
      if (selectedThreadId.current === id) { applyLatestPage(page); }
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
    attachmentOverride?:readonly StoredAttachment[],ownerInputResponse?:import("@/lib/ai/supervisor/ownerInput/contracts").OwnerInputResponse) {
    if(!navigator.onLine||sessionDenied||restoringFiles||(threadId!==null&&deniedThread===threadId))return;
    const inputText=value.trim() || (attachments.length>0?copy.photoRequest:"");
    const context=eventContext?.threadId===(targetThreadId??threadId)?eventContext:null;
    const text=ownerInputResponse?inputText:eventOwnerMessage(inputText,context);
    // A confirmed background job accepts follow-ups while the first response streams.
    // The main-turn double-tap guard must not intercept this separate path.
    if (!ownerInputResponse && !targetThreadId && !existingKey && enabled && canUseAi && text && (sending ? Boolean(liveJobId) : resumedRunning) &&
      !uploading && !recorder.current && dictation !== "recognizing" && text.length <= 4000)
      return sendFollowUp(text);
    if(sendOnce.current)return;
    if (!enabled || !canUseAi || !text || sending || uploading || recorder.current || dictation === "recognizing" || text.length > 4000) return;
    sendOnce.current=true;
    const clientMessageId = sendKey(existingKey, retryId.current, () => crypto.randomUUID());
    retryId.current = clientMessageId;
    const matchedResponse=ownerInputResponse??(retryResponse.current?.key===clientMessageId?retryResponse.current.response:undefined);
    if(matchedResponse)retryResponse.current={key:clientMessageId,response:matchedResponse};
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
    let jobConfirmed = false, serverError = false, durableConfirmed=false;
    try {
      const id = targetThreadId ?? await ensureThread();
      attemptedThreadId = id;
      const response = await fetch("/api/ai/threads/" + encodeURIComponent(id) + "/agent", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(buildAgentSendBody(clientMessageId,text,locale,attachmentOverride??attachments,matchedResponse)),
      });
      if(response.status===401){clearDeniedSession();return;}
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
              name?: string; jobId?: string; mode?: string; runId?:string;investigationId?:string;ownerMessageId?:string };
            if(type==="ack"&&(typeof event.runId==="string"||typeof event.investigationId==="string")){
              durableConfirmed=true;jobConfirmed=true;finished=true;
              if(event.ownerMessageId)setAcceptedDurableIds(ids=>[...new Set([...ids,event.ownerMessageId!])]);
              setLiveNote(liveCopy.followUpQueued);
            } else if(type==="queued"&&durableConfirmed){
              finished=true;
            } else if (type === "ack" && typeof event.jobId === "string") {
              jobConfirmed = true;
              setLiveJobId(event.jobId);
              if (event.mode === "continuation") {
                setLiveNote(liveCopy.continuing);
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
              if(durableConfirmed){finished=true;continue;}
              serverError = true;
              throw new Error(event.code ?? "agent_turn_failed");
            } else if (type === "done") {
              finished = true;
              if (jobConfirmed) {
                // A continuation may follow on this same stream; show this answer now.
                const page = await loadMessages(id);
                applyLatestPage(page);
                setOptimisticOwner(null); setStreamedText(""); setLiveNote(null);
                setLiveJobId(null);
              }
            }
          }
        }
      } finally { reader.releaseLock(); }
      if (!finished) throw new Error("agent_stream_incomplete");
      const page = await loadMessages(id);
      applyLatestPage(page);
      setOptimisticOwner(null);
      await refreshThreads();
      retryId.current = null; retryResponse.current=null;setStreamedText("");
      dispatchDictation({ type: "reset" }); setMediaNotice(""); setAttachments([]);
    } catch (failure) {
      if (existingKey&&!matchedResponse) retryId.current = null;
      // Server may have persisted the owner turn before the response failed.
      if (attemptedThreadId) {
        try {
          const page = await loadMessages(attemptedThreadId);
          applyLatestPage(page);
        } catch { /* do not fabricate a durable turn */ }
      }
      if (jobConfirmed && !serverError) {
        // Connection dropped but the job keeps running: the watcher resumes it.
        setOptimisticOwner(null); retryId.current = null;retryResponse.current=null;
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
    if (!threadId || nextOffset === null || loading) return false;
    const requestedThread = threadId;
    const request = ++paginationRequest.current;
    // Older pages are loaded independently from SSE and can resolve in any
    // order. A different conversation must never receive an old page.
    pinned.current = false;
    setLoading(true);
    try {
      const page = await loadMessages(requestedThread, nextOffset);
      if (request !== paginationRequest.current || selectedThreadId.current !== requestedThread) return false;
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
      return true;
    } catch {
      if (request === paginationRequest.current && selectedThreadId.current === requestedThread) setError(true);
      return false;
    } finally {
      if (request === paginationRequest.current) setLoading(false);
    }
  }
  function selectThread(id: string | null, historyTitle?:string|null) {
    if (sending||uploading||dictation==="recognizing"||dictation==="listening") return;
    setWorkTarget(null);setWorkNotice("");setControlsTab(null);
    if(id&&id===threadId)return;
    if(threadId&&(draft.trim()||attachments.length||restoringFiles)){
      // Keep unsent text and its retry identity only in this mounted owner session.
      threadDrafts.current.set(threadId,{text:draft,key:retryId.current,response:retryResponse.current,fileIds:pendingFileSelection.current?.threadId===threadId?pendingFileSelection.current.ids:attachments.map(file=>file.id)});
      if(threadDrafts.current.size>20)threadDrafts.current.delete(threadDrafts.current.keys().next().value!);
    }
    const restored=id?threadDrafts.current.get(id):undefined;
    if(id)threadDrafts.current.delete(id);
    pendingFileSelection.current=id&&restored?.fileIds.length?{threadId:id,ids:restored.fileIds}:null;
    setRestoringFiles(Boolean(pendingFileSelection.current));
    explicitNewChat.current=id===null;
    window.history.replaceState(null,"",conversationLocation(window.location.href,id));
    setAttachmentMenu(false);
    cleanupRecording(); dispatchDictation({ type: "reset" });
    paginationRequest.current++;
    prependAnchor.current = null;
    selectedThreadId.current = id;
    setLoading(false);
    messagePage.current={items:[],nextOffset:null};
    setThreadId(id); setDeniedThread(null);setMessages([]);setLoadedThreadId(null);setStartExpanded(false); setNextOffset(null);
    setAttachments([]);setStoredAttachments(null);
    setOptimisticOwner(null);
    openingThread.current = Boolean(id); pinned.current = true;
    setShowNewMessage(false);
    const title=historyTitle??threads.find((thread) => thread.id === id)?.title??null;
    selectedHistoryTitle.current=id?{id,title}:null;
    setThreadTitle(title);
    setEventContext(id&&title?eventContextFromTitle(title,id):null);
    setDraft(restored?.text??""); setMediaNotice(""); setError(false);
    setFailureCode(null); setQueuedOwner([]);
    retryId.current = restored?.key??null; retryResponse.current=restored?.response??null;threadRequestId.current = null;setAcceptedDurableIds([]);
    composer.current?.focus();
  }
  function openWork(item:OwnerWorkItem){
    if(sending||uploading||dictation==="recognizing"||dictation==="listening"||!item.threadId)return;
    if(item.threadId!==threadId)selectThread(item.threadId);
    setControlsTab(null);setWorkNotice("");setWorkTarget({threadId:item.threadId,proposalId:item.proposalId,messageId:item.proof?.kind==="verified_reply"?item.proof.ref:item.ownerMessageId});
  }
  useEffect(()=>{
    if(!workTarget||loadedThreadId!==workTarget.threadId||loading||sending||controlsOpen)return;
    const frame=requestAnimationFrame(()=>{
      const proposal=workTarget.proposalId;
      const message=workTarget.messageId;
      if(!proposal&&!message){scrollToLatest();setWorkTarget(null);return;}
      const selector=proposal?"[data-work-proposal]":"[data-work-message]";
      const nodes=Array.from(transcript.current?.querySelectorAll<HTMLElement>(selector)??[]);
      const linked=document.querySelector<HTMLElement>('[data-testid="experiment-deeplink"]');
      if(linked&&proposal)nodes.push(linked);
      const node=nodes.find(el=>proposal?el.dataset.workProposal===proposal:el.dataset.workMessage===message);
      if(node){
        pinned.current=false;node.scrollIntoView({block:"center"});node.focus({preventScroll:true});
        setWorkTarget(null);return;
      }
      if(nextOffset!==null){
        void loadOlder().then(ok=>{
          if(!ok&&selectedThreadId.current===workTarget.threadId){setWorkNotice(en.SupervisorWork.stale);setWorkTarget(current=>current===workTarget?null:current);}
        });
      }else{setWorkNotice(en.SupervisorWork.stale);setWorkTarget(null);}
    });
    return()=>cancelAnimationFrame(frame);
  },[workTarget,loadedThreadId,loading,sending,controlsOpen,nextOffset,messages,loadOlder]);
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
  function pickAttachment(camera:boolean){
    const input=filePicker.current;
    if(!input||offline)return;
    // One existing upload input and endpoint; native camera is a browser hint.
    if(camera){input.accept="image/jpeg,image/png,image/webp";input.setAttribute("capture","environment");}
    else {input.accept=".txt,.csv,.xlsx,.pdf,.jpg,.jpeg,.png,.webp,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf,image/jpeg,image/png,image/webp";input.removeAttribute("capture");}
    setAttachmentMenu(false);attachmentTrigger.current?.focus();input.click();
  }
  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !enabled || !canUseAi || restoringFiles || uploading || sending || !navigator.onLine) return;
    if(attachments.length>=3){setMediaNotice(fileCopy.limit);return;}
    const imageFile=file.type.startsWith("image/")||/\.(jpe?g|png|webp)$/i.test(file.name);
    const limit=imageFile?8*1024*1024:2*1024*1024;
    if (file.size > limit || file.size === 0) { setMediaNotice(fileCopy.tooLarge); return; }
    setUploading(true); setError(false);
    try {
      const id = await ensureThread();
      const body = new FormData(); body.append("file", file);
      const result = await jsonFrom<{ attachment: StoredAttachment }>(await fetch(
        "/api/ai/threads/" + encodeURIComponent(id) + "/attachments", { method: "POST", body }));
      setAttachments(old=>old.length>=3?old:[result.attachment,...old]);
      setStoredAttachments(old=>({threadId:id,items:[result.attachment,...(old?.threadId===id?old.items.filter(item=>item.id!==result.attachment.id):[])]}));
      setMediaNotice(copy.attachmentSaved);setReloadVersion(v=>v+1);
      // Upload receipt is authoritative, even when the unrelated library refresh fails.
      try{await refreshThreads();}catch(error){if(error instanceof ConversationReadError&&[401,403].includes(error.status))clearDeniedSession();}
    } catch(error) { if(error instanceof ConversationReadError&&error.status===401)clearDeniedSession();else {
      setError(false);setMediaNotice(error instanceof ConversationReadError&&error.status>=400&&error.status<500?fileCopy.failed:en.SupervisorExperience.uploadUnconfirmed);setReloadVersion(v=>v+1);
    } }
    finally { setUploading(false); }
  }
  function composerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !window.matchMedia("(pointer: coarse)").matches) {
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
  for(const item of durableWork){if(item.ownerMessageId)inFlightOwnerIds.add(item.ownerMessageId);for(const id of item.relatedOwnerMessageIds??[])inFlightOwnerIds.add(id);}
  for(const id of acceptedDurableIds)inFlightOwnerIds.add(id);
  const pendingOwnerIds = new Set(!sending && !supervisorWork.loading ? messages
    .filter((message) => message.role === "owner" && Boolean(message.clientMessageId) &&
      !answeredOwnerIds.has(message.id) && !inFlightOwnerIds.has(message.id))
    .map((message) => message.id) : []);
  const threadUnavailable=threadId!==null&&deniedThread===threadId;
  const inputLocked = threadUnavailable||sending && !liveJobId;
  const shownFailure = failureCode ?? (watcher.job?.status === "failed" ? watcher.job.errorCode ?? null : null);
  const durationLabel = String(Math.floor(elapsed / 60)) + ":" + String(elapsed % 60).padStart(2, "0");
  // A tap on a saved event opens that day in the same Supervisor conversation.
  const boardAskDisabled = threadUnavailable || restoringFiles || offline || !enabled || !canUseAi || sending || uploading || dictation === "recognizing" || resumedRunning;
  const chatAboutEventDay=async(date:string,title:string,eventId?:string,existingThreadId?:string,
    cityEventId?:string,draftPrompt?:string)=>{
    if(boardAskDisabled||openingEvent.current)return;
    openingEvent.current=true;
    try{
      // Existing plan threads represent a whole day, not one saved event.
      if(existingThreadId&&!eventId&&!cityEventId){
        eventThreadIds.current.set(eventThreadKey(date),existingThreadId);
        selectThread(existingThreadId);
        setEventContext({date,title,threadId:existingThreadId});
        if(draftPrompt)setDraft(draftPrompt);
        return;
      }
      const recovered=eventThreadFromHistory(threads,date,eventId,cityEventId);
      if(recovered)eventThreadIds.current.set(eventThreadKey(date,eventId,cityEventId),recovered);
      const chosenId=await openEventDayThread({
        date,title,eventId,cityEventId,known:eventThreadIds.current,
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
      setEventContext({date,title,eventId,cityEventId,threadId:chosenId});
      if(draftPrompt)setDraft(draftPrompt);
    }catch{
      setError(true);setFailureCode("agent_request_failed");
    }finally{openingEvent.current=false;}
  };
  // Only saved event facts are read on Home; no paid search starts when opening the panel.
  const comingUpCard = enabled && canUseAi ? <SavedEventsCard locale={locale}
    compact={!startExpanded}
    onChatAboutDay={(date,title,eventId,existingThreadId,cityEventId,draftPrompt)=>
      void chatAboutEventDay(date,title,eventId,existingThreadId,cityEventId,draftPrompt)}
    chatDisabled={boardAskDisabled}/> : undefined;

  if(sessionDenied)return <section className="mx-auto max-w-lg space-y-4 rounded-xl bg-surface p-6" aria-label={copy.composerLabel}><p role="alert" className="text-[17px] text-ink">{en.SupervisorExperience.sessionDenied}</p><Link href="/login" className="inline-flex min-h-12 items-center rounded-lg bg-accent px-4 text-on-accent">{en.SupervisorExperience.signInAgain}</Link></section>;
  return <section ref={shell} className="supervisor-shell relative flex min-h-[320px] min-w-0 flex-col overflow-hidden rounded-2xl bg-surface"
    aria-label={copy.composerLabel}>
    <header className="flex shrink-0 items-center gap-1 px-2 py-2 sm:px-4">
      <button type="button" onClick={()=>setControlsTab("library")}
        aria-expanded={controlsTab!==null&&controlsTab!=="work"}
        aria-label={en.SupervisorMandateCenter.open} title={en.SupervisorMandateCenter.open}
        className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-full text-ink hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
        <Menu size={22} aria-hidden="true"/>
      </button>
      <button type="button" onClick={() => setControlsTab("work")} disabled={!enabled}
        aria-expanded={controlsTab==="work"} aria-label={en.SupervisorWork.heading} title={en.SupervisorWork.heading}
        className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-full text-ink-muted hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
        <ListChecks size={21} aria-hidden="true" />
      </button>
      <h2 className="min-w-0 flex-1 truncate text-center font-headline text-[17px] font-medium tracking-tight text-ink">
        {threadTitle || copy.supervisor}
      </h2>
      <button type="button" onClick={() => selectThread(null)} disabled={!enabled || !canUseAi || sending || uploading || dictation==="recognizing" || dictation==="listening"}
        aria-label={copy.startNewChat} title={copy.startNewChat}
        className="inline-flex min-h-12 min-w-12 items-center justify-center rounded-full text-ink hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-50">
        <SquarePen size={21} aria-hidden="true" />
      </button>
    </header>
    {threadUnavailable&&<p role="alert" className="shrink-0 border-b border-line px-4 py-2 text-[17px] text-ink">{en.SupervisorExperience.threadUnavailable}</p>}
    {offline&&<p role="status" className="shrink-0 border-b border-line px-4 py-2 text-[15px] text-ink-muted">{en.SupervisorExperience.offline}</p>}
    {chatStartPromise&&hasChatMessages&&<div className="max-h-[35dvh] shrink-0 overflow-y-auto px-2 sm:px-4 md:max-h-[48dvh]">
      <Suspense key={boardPeriod} fallback={<p role="status" className="p-3 text-[17px] text-ink-muted">{copy.sending}</p>}>
        <DeferredChatStart promise={chatStartPromise} suggestions={copy.suggestions} failureText={copy.unverified}
          hasMessages expanded={startExpanded} onToggle={()=>setStartExpanded(v=>!v)}
          onSuggestion={()=>{}} suggestionsDisabled comingUp={comingUpCard}/>
      </Suspense>
    </div>}
    {!chatStartPromise&&chatStartData&&chatStartCopy&&hasChatMessages&&<div className="max-h-[35dvh] shrink-0 overflow-y-auto px-2 sm:px-4 md:max-h-[48dvh]">
      <ChatStart data={chatStartData} copy={{...chatStartCopy,suggestions:copy.suggestions}}
        hasMessages expanded={startExpanded} onToggle={()=>setStartExpanded(v=>!v)}
        onSuggestion={()=>{}} suggestionsDisabled
        comingUp={comingUpCard}/>
    </div>}
    <div ref={transcript} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none] px-4 py-3 sm:px-6 md:py-5"
      onScroll={onTranscriptScroll} role="log" aria-live="polite" aria-label={copy.threads}>
      <div ref={messageContent} className="mx-auto flex min-h-full w-full max-w-[46rem] min-w-0 flex-col items-stretch justify-start gap-5">
      {workNotice&&<p role="status" className="text-sm text-ink-muted">{workNotice}</p>}
      {!hasChatMessages&&startReady&&!threadUnavailable&&<SupervisorWelcome heading={copy.emptyHeading} intro={copy.emptyIntro}/>}
      {chatStartPromise&&!hasChatMessages&&startReady&&
        <Suspense key={boardPeriod} fallback={<p role="status" className="p-3 text-[17px] text-ink-muted">{copy.sending}</p>}>
          <DeferredChatStart promise={chatStartPromise} suggestions={copy.suggestions} failureText={copy.unverified}
            hasMessages={false} expanded={startExpanded} onToggle={()=>setStartExpanded(v=>!v)}
            onSuggestion={prompt=>{retryId.current=null;void sendText(prompt);}}
            suggestionsDisabled={threadUnavailable||restoringFiles||offline||!enabled||!canUseAi||sending||uploading||dictation==="recognizing"||resumedRunning}
            unavailableMessage={!enabled ? copy.unavailable : undefined}
            comingUp={comingUpCard}/>
        </Suspense>}
      {!chatStartPromise&&chatStartData&&chatStartCopy&&!hasChatMessages&&startReady&&
        <ChatStart data={chatStartData} copy={{...chatStartCopy,suggestions:copy.suggestions}}
          hasMessages={false} expanded={startExpanded} onToggle={()=>setStartExpanded(v=>!v)}
          onSuggestion={prompt=>{retryId.current=null;void sendText(prompt);}}
          suggestionsDisabled={threadUnavailable||restoringFiles||offline||!enabled||!canUseAi||sending||uploading||dictation==="recognizing"||resumedRunning}
          unavailableMessage={!enabled ? copy.unavailable : undefined}
          comingUp={comingUpCard}/>}

      {!chatStartPromise&&!chatStartData&&!hasChatMessages&&!enabled&&<p role="status" className="text-[17px] text-ink-muted">{copy.unavailable}</p>}
      {nextOffset !== null && <button type="button" onClick={() => void loadOlder()} disabled={loading||offline}
        className="mx-auto flex min-h-12 items-center gap-2 rounded-xl px-4 text-[15px] font-semibold text-ink underline hover:bg-surface2">
        <Clock3 size={18} aria-hidden="true" /> {copy.more}
      </button>}
      {displayedMessages.map((message,messageIndex) => {
        const clarify=clarifyCardState(clarifyVisibilityMessages,messageIndex,activeDurableQuestions);
        return <div key={message.id} data-work-message={message.id} tabIndex={-1} data-client-message-id={message.role === "owner" ? message.clientMessageId ?? undefined : undefined} className="space-y-2">
        <SupervisorMessage message={message} copy={copy} locale={locale} cafeCurrency={cafeCurrency} storedFiles={storedAttachments}
          linkedThreadId={threadId===initialThreadId?initialThreadId:undefined}
          linkedProposalId={threadId===initialThreadId?initialProposalId:undefined}
          clarifyState={chosenClarify[message.id]&&clarify.state==="skipped"?"chosen":clarify.state}
          clarifyChoice={chosenClarify[message.id]??clarify.choice}
          suggestionsDisabled={threadUnavailable||restoringFiles||offline||!enabled||!canUseAi||sending||uploading||dictation==="recognizing"||dictation==="listening"||resumedRunning}
          onSuggest={value=>{setDraft(current=>current.trim()?current.trimEnd().length+value.length+1<=4000?current.trimEnd()+"\n"+value:current:value);retryId.current=null;composer.current?.focus();}}
          onClarify={value=>{if(offline||threadUnavailable||sending||uploading||restoringFiles)return;setChosenClarify(old=>({...old,[message.id]:value}));void sendText(value,undefined,undefined,undefined,typeof message.grounding?.durableQuestionId==="string"?{questionId:message.grounding.durableQuestionId,action:"supply"}:undefined);}}
          onFacts={async(questionId,answers)=>{
            if(!threadId||message.threadId!==threadId||!navigator.onLine||threadUnavailable||sending||uploading||restoringFiles)throw new Error("thread_unavailable");
            const response=await fetch("/api/ai/threads/"+encodeURIComponent(threadId)+"/owner-answer",{
              method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
              body:JSON.stringify({questionId,answers,locale})
            });
            if(!response.ok)throw new Error("owner_answer_save_failed");
            const result=await response.json() as {saved:boolean;writeThroughApplied:boolean;remembered?:number;forgotten?:number};
            if(!result.saved)throw new Error("owner_answer_save_failed");
            const savedCopy=({en,es,ar}[locale]).OwnerQuestions;
            const responseText=ownerAnswerAcknowledgement(result,savedCopy);
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
              value:answer.forget?savedCopy.forgottenValue:answer.value
            }));
            const durableId=message.grounding?.durableQuestionId;
            await sendText(resumeOwnerQuestion(typeof durableId==="string"?null:original,responseText,facts),undefined,undefined,undefined,typeof durableId==="string"?{questionId:durableId,action:"supply"}:undefined);
          }}
          disabled={offline||threadUnavailable||restoringFiles||uploading||sending||!enabled||!canUseAi||
          (message.role==="supervisor"&&message.id!==activeQuestionMessageId&&clarify.state!=="active")}
          onOwnerResponse={(origin,value,isOption,dismiss=false)=>{
            if(offline||threadUnavailable||restoringFiles||uploading||sending||!enabled||!canUseAi||origin.id!==activeQuestionMessageId)return;
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
          <button type="button" onClick={() => void sendText(message.text ?? "", message.clientMessageId ?? undefined,undefined,undefined,message.ownerInputResponse)}
            disabled={offline||!canUseAi} className="min-h-12 rounded-xl bg-accent px-3 font-bold text-on-accent disabled:opacity-50">{copy.retryAnswer}</button>
        </div>}
      </div>;
      })}
      <SupervisorWorkStatus items={supervisorWork.items} unavailable={supervisorWork.unavailable} onOpen={openWork} disabled={sending}/>
      {queuedOwner.map((item) => <article key={item.id} className="ms-auto w-fit max-w-[80%] rounded-2xl bg-surface2 px-4 py-3 text-[17px] leading-relaxed text-ink opacity-80">
        <p className="whitespace-pre-wrap break-words">{item.text}</p>
      </article>)}
      {(sending && liveJobId || resumedRunning) && <ChatJobProgress locale={locale} acknowledged
        steps={sending ? liveSteps : watcher.job?.progress ?? []}
        note={sending ? liveNote : liveCopy.resumed} />}
      {sending && streamedText && <article aria-live="off" aria-busy="true" className="w-full space-y-3"><div className="flex items-center gap-2 text-[15px] font-bold text-ink-muted"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-pos-soft text-good"><Sparkles size={17} aria-hidden="true"/></span>{copy.supervisor}</div><ReplyBlock block={{type:"text",text:streamedText}} copy={copy} locale={locale}/></article>}
      {sending && <div className="flex items-center gap-3 text-[16px] text-ink-muted" role="status">
        {parseAgentId(progressStatus?.agent) ?
          <span className="shrink-0"><AgentAvatar agentId={parseAgentId(progressStatus?.agent)!} size="task" /></span> :
          <CafeActivity brewing={!liveJobId}/>}
        {progressStatusText(copy, progressStatus) ?? copy.sending}
      </div>}
      </div>
    </div>
    {showNewMessage && <button type="button" onClick={scrollToLatest} className="mx-auto inline-flex min-h-12 max-w-full shrink-0 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-accent-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"><ArrowDown size={16} aria-hidden="true" />{copy.newMessage}</button>}
    {initialProposalId && initialThreadId && threadId === initialThreadId && <div className="max-h-[50dvh] shrink-0 overflow-y-auto" data-testid="experiment-deeplink" data-work-proposal={initialProposalId} tabIndex={-1}>
      <SupervisorExperiment key={initialThreadId + ":" + initialProposalId}
        threadId={threadId} locale={locale} canUseAi={canUseAi}
        copy={{en,es,ar}[locale].SupervisorExperiment}
        initialProposalId={initialProposalId} refreshVersion={messages.length} />
    </div>}
    <div className="mx-auto mt-auto w-full max-w-[49rem] shrink-0 bg-surface px-2 pb-2 pt-1 sm:px-4">
      {attachments.length > 0 && <div className="mb-2 flex flex-wrap gap-2" aria-label={copy.addAttachment}>
        {attachments.map(file=><div key={file.id}
          className="inline-flex max-w-full min-h-10 items-center gap-1 rounded-xl bg-surface ps-3 text-[14px] font-semibold text-ink">
          <Paperclip size={17} aria-hidden="true"/>
          <a href={"/api/ai/threads/"+encodeURIComponent(threadId??"")+"/attachments/"+encodeURIComponent(file.id)}
            target="_blank" rel="noopener noreferrer" className="min-w-0 truncate underline">
            {file.originalName}</a>
          <button type="button" disabled={sending}
            onClick={()=>setAttachments(old=>old.filter(x=>x.id!==file.id))}
            aria-label={fileCopy.remove+" "+file.originalName}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg hover:bg-surface2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
            <X size={16} aria-hidden="true"/>
          </button>
        </div>)}
      </div>}
      {storedAttachments?.threadId===threadId && storedAttachments.items.length>0 &&
        <details className="mb-2">
          <summary className="min-h-12 cursor-pointer py-3 text-[15px] font-medium text-ink-muted">{fileCopy.recent}</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {storedAttachments.items.filter(file=>!attachments.some(a=>a.id===file.id)).slice(0,8).map(file=>
              <button key={file.id} type="button" disabled={sending}
                onClick={()=>{
                  if(attachments.length>=3){setMediaNotice(fileCopy.limit);return;}
                  setAttachments(old=>old.some(a=>a.id===file.id)?old:[file,...old]);
                }}
                aria-label={fileCopy.reuse+" "+file.originalName}
                className="inline-flex min-h-12 max-w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 text-[15px] font-medium text-ink hover:bg-surface2">
                <Paperclip size={16} aria-hidden="true"/><span className="truncate">{file.originalName}</span>
              </button>)}
          </div>
        </details>}
      {eventContext?.threadId===threadId&&
        <div role="status" className="mb-2 flex min-h-10 items-center gap-2 rounded-xl bg-accent-soft px-3 py-2 text-[15px] font-semibold text-ink">
          <span className="min-w-0 flex-1 break-words">@event {eventContext.title} · {eventContext.date}</span>
          <button type="button" onClick={()=>setEventContext(null)} aria-label={copy.removeEventContext}
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink">
            <X size={18} aria-hidden="true"/>
          </button>
        </div>}
      {restoringFiles&&<div role="status" className="flex items-center gap-2 text-[15px] text-ink-muted"><CafeActivity/>{en.SupervisorExperience.checkingFiles} <button type="button" onClick={()=>{pendingFileSelection.current=null;setRestoringFiles(false);}} className="min-h-12 underline">{en.SupervisorExperience.removeSelection}</button></div>}
      {attachmentMenu&&<div id="supervisor-attachment-choices" role="group" aria-label={copy.addAttachment} className="mb-2 flex flex-wrap gap-2 rounded-xl border border-line p-2" onKeyDown={e=>{if(e.key==="Escape"){setAttachmentMenu(false);attachmentTrigger.current?.focus();}}}>
        <button ref={attachmentFirstChoice} type="button" disabled={offline} className="flex min-h-12 flex-1 items-center gap-2 rounded-lg px-3 text-start hover:bg-surface2 disabled:opacity-50" onClick={()=>pickAttachment(false)}><Paperclip size={18} aria-hidden="true"/>{en.SupervisorExperience.chooseFile}</button>
        <button type="button" disabled={offline} className="flex min-h-12 flex-1 items-center gap-2 rounded-lg px-3 text-start hover:bg-surface2 disabled:opacity-50" onClick={()=>pickAttachment(true)}><Camera size={18} aria-hidden="true"/>{en.SupervisorExperience.takePhoto}</button>
      </div>}
      <form onSubmit={(event) => { event.preventDefault(); void sendText(draft); }}
        className="grid grid-cols-[48px_minmax(0,1fr)_48px_48px] items-end gap-0.5 rounded-[24px] border border-line bg-surface p-1.5 focus-within:border-accent">
        <input ref={filePicker} type="file" className="sr-only" tabIndex={-1} aria-hidden="true"
          accept=".txt,.csv,.xlsx,.pdf,.jpg,.jpeg,.png,.webp,text/plain,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf,image/jpeg,image/png,image/webp"
          onChange={(event) => void attach(event)} />
        <button ref={attachmentTrigger} type="button" onClick={() => setAttachmentMenu(v=>!v)} aria-expanded={attachmentMenu} aria-controls={attachmentMenu?"supervisor-attachment-choices":undefined}
          aria-label={copy.addAttachment} title={copy.addAttachment}
          disabled={restoringFiles || threadUnavailable || offline || !enabled || !canUseAi || sending || uploading || dictation === "listening" || dictation === "recognizing"}
          className="col-start-1 row-start-2 flex h-12 w-12 items-center justify-center rounded-full text-ink-muted hover:bg-surface2 disabled:opacity-50 sm:row-start-1">
          <Plus size={22} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => void listen()}
          aria-label={dictation === "listening" ? copy.voiceStop : copy.voiceInput}
          title={dictation === "listening" ? copy.voiceStop : copy.voiceInput}
          aria-pressed={dictation === "listening"}
          disabled={threadUnavailable || (offline&&dictation!=="listening") || !enabled || !canUseAi || sending || uploading || dictation === "recognizing"}
          className={dictation === "listening"
            ? "col-start-3 row-start-2 flex h-12 w-12 items-center justify-center rounded-full bg-neg text-paper ring-2 ring-neg-soft animate-pulse motion-reduce:animate-none sm:row-start-1"
            : "col-start-3 row-start-2 flex h-12 w-12 items-center justify-center rounded-full text-ink-muted hover:bg-surface2 disabled:opacity-40 sm:row-start-1"}>
          {dictation === "listening" ? <Square size={20} fill="currentColor" aria-hidden="true" />
            : dictation === "recognizing" ? <LoaderCircle size={21} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              : <Mic size={22} aria-hidden="true" />}
        </button>
        <label htmlFor="supervisor-home-composer" className="sr-only">{copy.askAnything}</label>
        <textarea id="supervisor-home-composer" ref={composer}
          rows={1} maxLength={4000} value={draft}
          onChange={(event) => { if(!threadId&&event.target.value)explicitNewChat.current=true;setDraft(event.target.value); retryId.current = null; }}
          onKeyDown={composerKey} disabled={!enabled || !canUseAi || inputLocked}
          placeholder={eventContext?.threadId===threadId?"@event "+eventContext.title+" · "+copy.askAnything:copy.askAnything}
          className="col-span-4 col-start-1 row-start-1 min-w-0 max-h-40 min-h-12 resize-none overflow-y-auto bg-transparent px-3 py-3 text-[17px] leading-6 text-ink outline-none placeholder:text-ink-muted disabled:opacity-50 sm:col-span-1 sm:col-start-2 sm:px-2" />
        <button type="submit" aria-label={copy.sendMessage}
          disabled={restoringFiles || offline || !enabled || !canUseAi || inputLocked || (!draft.trim()&&!attachments.length) || dictation === "listening" || dictation === "recognizing"}
          className="col-start-4 row-start-2 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-on-accent transition-transform hover:brightness-95 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40 sm:row-start-1">
          <ArrowUp size={22} aria-hidden="true" />
        </button>
      </form>
      {dictation === "listening" && <p className="mt-1 text-sm font-bold text-neg" role="status">
        {copy.recording} {durationLabel} · {copy.voiceStop}
      </p>}
      {dictation === "recognizing" && <p className="mt-1 flex items-center gap-2 text-sm text-ink-muted" role="status">
        <CafeActivity/>{copy.transcribing}
      </p>}
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-[14px] text-ink-muted">
        {uploading&&<CafeActivity/>}
        {failureCode && (!error || pendingOwnerIds.size === 0) ? failureLine(failureCode, liveCopy)
          : error && pendingOwnerIds.size === 0 ? copy.answerFailed : uploading ? copy.attachmentUpload
          : dictation === "error" || dictation === "ready" ? mediaNotice
            : mediaNotice}
      </div>
    </div>
    {controlsOpen && <SupervisorMandatePanel threadId={threadId} threads={threads}
      approvals={supervisorWork.items.filter(item=>item.status==="approval_required")
        .map(item=>({id:item.id,title:item.title,detail:item.detail}))}
      initialTab={controlsTab??"permissions"} onOpenWork={openWork} disabled={sending||uploading||dictation==="recognizing"||dictation==="listening"}
      languageSwitch={<div className="shrink-0 border-t border-line px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <nav aria-label={{en,es,ar}[locale].Nav.ariaLabel} className="grid grid-cols-3 gap-1 md:hidden">
          {NAV_TABS.map(({href,key,Icon})=><Link key={href} href={href} onClick={()=>setControlsTab(null)}
            aria-current={href==="/"? "page":undefined}
            className="flex min-h-12 min-w-0 items-center gap-2 rounded-lg px-2 text-[14px] text-ink hover:bg-surface2">
            <Icon size={18} className="shrink-0" aria-hidden="true"/><span className="min-w-0 break-words">{{en,es,ar}[locale].Nav[key]}</span>
          </Link>)}
        </nav>
        <Link href="/operations" className="hidden min-h-12 items-center gap-2 rounded-lg px-2 text-[17px] text-ink hover:bg-surface2 md:flex"><UsersRound size={20} aria-hidden="true"/>{copy.teamButton}</Link>
        {languageSwitch&&<div className="md:hidden">{languageSwitch}</div>}
      </div>} files={storedAttachments} reports={loadedSavedReports(messages,threadId)} onOpenReport={id=>{if(!threadId)return;setControlsTab(null);setWorkNotice("");setWorkTarget({threadId,messageId:id});}} threadsNextOffset={threadsNextOffset} onSelectThread={(id,thread)=>selectThread(id,thread?.title)} onClose={()=>setControlsTab(null)}/>}
  </section>;
}
