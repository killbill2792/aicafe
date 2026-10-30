"use client";

import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { Period } from "@/lib/viewmodels/period";
import type { AgentId } from "@/lib/operating/tasks";
import { AgentAvatar } from "@/components/operations/agentVisuals";
import PeriodSwitch from "@/components/shared/PeriodSwitch";
import { CHAT_START_AGENTS, topChatStartItems, type ChatStartAttentionItem } from "./chatStartAttention";

/** One preformatted Operating Board line with a link into its chat thread. */
export type BoardLine = { key: string; href: string; text: string };
export type ChatStartData = {
  period: Period;
  sales: string;
  costs: string;
  kept: string;
  attention: ChatStartAttentionItem[];
  partial: boolean;
  estimated: boolean;
  incomplete: boolean;
  shareCaption: string|null;
  /** Under Sales on Today: "Live · updated 10:15" from the saved Toast reading. */
  salesCaption?: string|null;
  comparisonCaption: string|null;
  /** Experiments the operator is running and its recent reports (same rows as the chat). */
  board?: { running: BoardLine[]; reports: BoardLine[] };
};
export type ChatStartCopy = {
  keyNumbers: string;
  sales: string;
  knownCosts: string;
  youKeep: string;
  partial: string;
  estimate: string;
  incomplete: string;
  details: string;
  seeAll: string;
  allGood: string;
  summary: string; // One server-formatted ICU message, including every number.
  roles: Record<AgentId, string>;
  suggestions: string[];
  experimentPrompt: string;
  suggestionsLabel: string;
  handledLabel: string;
  boardRunning?: string;
  boardReports?: string;
};
export type ChatStartProps = {
  data: ChatStartData;
  copy: ChatStartCopy;
  hasMessages: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSuggestion: (prompt: string) => void;
  suggestionsDisabled: boolean;
  unavailableMessage?: string;
};

function SafeAction({ item }: { item: ChatStartAttentionItem }) {
  const className = "mt-auto inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-accent-soft px-2 py-2 text-[15px] font-semibold text-accent-text no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
  // The shared reader validates relative-only hrefs. OAuth setup needs an actual navigation.
  if (!item.href.startsWith("/") || item.href.startsWith("//")) return null;
  return item.href.startsWith("/api/pos/square/connect?")
    ? <a className={className} href={item.href}>{item.actionLabel}</a>
    : <Link className={className} href={item.href}>{item.actionLabel}</Link>;
}

/** One chat-start surface, never a second Home dashboard or attention query. */
export default function ChatStart({ data, copy, hasMessages, expanded, onToggle, onSuggestion, suggestionsDisabled, unavailableMessage }: ChatStartProps) {
  const tops = topChatStartItems(data.attention);
  return <div className="w-full min-w-0 space-y-3" data-testid="chat-start">
    {hasMessages && <button type="button" aria-expanded={expanded} onClick={onToggle}
      className="flex min-h-12 w-full min-w-0 items-center gap-2 rounded-xl border border-line bg-card px-3 text-start text-[15px] font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
      <span className="min-w-0 flex-1 truncate" dir="auto">{copy.summary}</span>
      {expanded ? <ChevronUp size={18} className="shrink-0" aria-hidden="true" /> :
        <ChevronDown size={18} className="shrink-0" aria-hidden="true" />}
    </button>}
    {(!hasMessages || expanded) && <>
      <section className="min-w-0 rounded-2xl border border-line bg-card p-3" aria-label={copy.keyNumbers}>
        <PeriodSwitch current={data.period} />
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          {([
            { label: copy.sales, value: data.sales },
            { label: copy.knownCosts, value: data.costs },
            { label: copy.youKeep, value: data.kept },
          ] as const).map((number) => <div key={number.label} className="min-w-0 rounded-xl bg-surface2 p-2">
            <p className="text-[13px] font-semibold leading-snug text-ink-muted">{number.label}</p>
            <p className="mt-1 break-words font-headline text-[17px] font-bold leading-tight text-ink" dir="auto">{number.value}</p>
            {number.label===copy.sales&&data.salesCaption&&<p className="mt-1 text-[13px] leading-snug text-ink-muted" dir="auto">{data.salesCaption}</p>}
            {number.label===copy.youKeep&&<>
              {data.shareCaption&&<p className="mt-1 text-[13px] leading-snug text-ink-muted">{data.shareCaption}</p>}
              {data.comparisonCaption&&<p className="mt-1 text-[13px] leading-snug text-ink-muted">{data.comparisonCaption}</p>}
            </>}
          </div>)}
        </div>
        {(data.partial || data.estimated || data.incomplete) && <p className="mt-2 text-[13px] text-ink-muted">
          {[data.partial ? copy.partial : null, data.estimated ? copy.estimate : null,
            data.incomplete ? copy.incomplete : null].filter(Boolean).join(" · ")}
        </p>}
        <Link href="/money" className="mt-1 inline-flex min-h-12 items-center text-[15px] font-semibold text-accent-text underline">{copy.details}</Link>
      </section>
      {data.board && (data.board.running.length > 0 || data.board.reports.length > 0) &&
        <section className="min-w-0 space-y-3 rounded-2xl border border-line bg-card p-3" data-testid="operating-board">
          {([[copy.boardRunning, data.board.running, "running"], [copy.boardReports, data.board.reports, "reports"]] as const)
            .filter(([, lines]) => lines.length > 0).map(([title, lines, id]) => <div key={id} className="min-w-0">
              <h3 className="text-[15px] font-semibold text-ink-muted">{title}</h3>
              <ul className="mt-1 space-y-1">
                {lines.map((line) => <li key={line.key} className="min-w-0">
                  <Link href={line.href} className="inline-flex min-h-12 w-full items-center break-words text-[15px] leading-snug text-ink underline-offset-2 hover:underline" dir="auto">
                    {line.text}
                  </Link>
                </li>)}
              </ul>
            </div>)}
        </section>}
      <section aria-label={copy.seeAll} className="min-w-0">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {CHAT_START_AGENTS.map((agentId) => {
            const item = tops[agentId];
            const name = agentId.charAt(0).toUpperCase() + agentId.slice(1);
            return <article key={agentId} data-agent-id={agentId} data-attention-id={item?.id}
              className="flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-card p-2.5">
              <div className="flex min-w-0 items-center gap-1.5">
                <AgentAvatar agentId={agentId} size="task" />
                <div className="min-w-0">
                  <h3 className="truncate text-[16px] font-semibold text-ink">{name}</h3>
                  <p className="truncate text-[13px] text-ink-muted">{copy.roles[agentId]}</p>
                </div>
              </div>
              {item ? <>
                <p className="min-w-0 flex-1 break-words text-[15px] leading-snug text-ink">{item.displayTitle}</p>
                <SafeAction item={item} />
              </> : <p className="flex flex-1 items-center gap-1.5 text-[15px] font-semibold text-ink">
                <Check size={18} aria-hidden="true" />{copy.allGood}
              </p>}
            </article>;
          })}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1">
          {/* Same period as the count above, so Operations shows the same list. */}
          <Link href={{ pathname: "/operations", query: data.period === "today" ? {} : { period: data.period } }}
            className="inline-flex min-h-12 items-center text-[15px] font-semibold text-accent-text underline">
            {copy.seeAll}
          </Link>
          <Link href="/operations?status=handled" className="inline-flex min-h-12 items-center text-[15px] font-semibold text-accent-text underline">
            {copy.handledLabel}
          </Link>
        </div>
      </section>
      {unavailableMessage && <p role="status" className="rounded-xl border border-line bg-surface2 p-3 text-[17px] text-ink">{unavailableMessage}</p>}
      {!hasMessages && copy.suggestions.length > 0 && <div className="min-w-0" aria-label={copy.suggestionsLabel}>
        <div className="flex max-w-full gap-2 overflow-x-auto overscroll-x-contain pb-2" dir="inherit">
          {copy.suggestions.map((label, index) => <button type="button" key={index}
            disabled={suggestionsDisabled} onClick={() => onSuggestion(index === 3 ? copy.experimentPrompt : label)}
            className="inline-flex min-h-12 w-max shrink-0 items-center whitespace-nowrap rounded-full bg-accent-soft px-4 py-2 text-[15px] font-semibold text-accent-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-50">
            {label}
          </button>)}
        </div>
      </div>}
    </>}
  </div>;
}
