"use client";

import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import AITeamCard, { AgentAvatar } from "@/components/operations/AITeamCard";
import TeamRulesManager, { type TeamRulesCopy } from "@/components/operations/TeamRulesManager";
import type { AgentId } from "@/lib/operating/tasks";
import type { TeamMemberState } from "@/lib/viewmodels/operationsTeam";
import { INBOX_STATUSES, inboxQueryAfter, readInboxSelection, type InboxStatus } from "@/lib/viewmodels/teamInboxSelection";

export type TeamInboxCard = { id: string; agentId: AgentId; status: InboxStatus; node: ReactNode };
export type TeamInboxCopy = {
  eyebrow: string; title: string; intro: string; focusedOn: Record<AgentId, string>;
  team: { title: string; aiLabel: string; brandLabel: string; names: Record<AgentId, string>; roles: Record<AgentId, string>;
    status: Record<AgentId, string>; need: Record<AgentId, string | null> };
  statusLabels: Record<InboxStatus, string>; navLabel: string; empty: Record<InboxStatus, string>;
  rules: { title: string; intro: string; heading: Record<AgentId | "supervisor", string>; manager: TeamRulesCopy } | null;
  transportUnavailable: string;
};

/** Every card is rendered once on the server; picking a teammate or tab only filters them here
 * and updates the URL, so switching never waits on a server reload. */
export default function TeamInbox({ members, cards, copy, staffRulesLink, footer }: {
  members: TeamMemberState[]; cards: TeamInboxCard[]; copy: TeamInboxCopy; staffRulesLink: ReactNode; footer: ReactNode;
}) {
  const params = useSearchParams();
  const { agent, status } = readInboxSelection(params);
  const go = (change: { agent: AgentId } | { status: InboxStatus }) =>
    window.history.pushState(null, "", window.location.pathname + inboxQueryAfter(params.toString(), change));
  const visible = (value: InboxStatus) => cards.filter((card) => card.status === value && (!agent || card.agentId === agent));
  const shown = visible(status);
  const extraQuery = Object.fromEntries([...params.entries()].filter(([key]) => key !== "agent" && key !== "status"));
  const team = { members, needsYou: [], handled: [], watching: [] };
  const teamCopy = { ...copy.team, status: (member: TeamMemberState) => copy.team.status[member.agentId],
    need: (member: TeamMemberState) => copy.team.need[member.agentId] };

  return <>
    <header><p className="text-sm font-semibold text-ink-muted">{copy.eyebrow}</p><h1 className="font-headline text-3xl font-bold text-ink">{copy.title}</h1><p className="mt-1 text-[17px] text-ink-muted">{agent ? copy.focusedOn[agent] : copy.intro}</p></header>
    <AITeamCard team={team} copy={teamCopy} selectedAgent={agent} selectedStatus={params.get("status") ? status : undefined}
      extraQuery={extraQuery} onSelect={(agentId) => go({ agent: agentId })} />
    {staffRulesLink}
    {copy.rules && <section id="team-rules" className="flex flex-col gap-3" aria-labelledby="selected-agent-rules">
      <div className="flex items-center gap-3 px-1">
        {agent && <AgentAvatar agentId={agent} size="task" />}
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-muted">{copy.rules.title}</p>
          <h2 id="selected-agent-rules" className="truncate font-headline text-2xl font-bold text-ink">{copy.rules.heading[agent ?? "supervisor"]}</h2>
          <p className="mt-1 text-[17px] text-ink-muted">{copy.rules.intro}</p>
        </div>
      </div>
      <TeamRulesManager selectedAgent={agent ?? "supervisor"} copy={copy.rules.manager} />
    </section>}
    <nav className="grid grid-cols-3 gap-1 rounded-2xl bg-card p-1" aria-label={copy.navLabel}>
      {INBOX_STATUSES.map((value) => <a key={value} href={inboxQueryAfter(params.toString(), { status: value }) || "?"}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          go({ status: value });
        }}
        aria-current={status === value ? "page" : undefined}
        className={`flex min-h-12 items-center justify-center rounded-xl px-2 text-center text-sm font-bold no-underline ${status === value ? "bg-accent text-on-accent" : "text-ink-muted"}`}>
        {copy.statusLabels[value]} {visible(value).length}
      </a>)}
    </nav>
    {shown.length === 0
      ? <section className="rounded-card-lg bg-card p-[18px]"><p className="text-[17px] text-ink-muted">{copy.empty[status]}</p></section>
      : <section className="flex flex-col gap-3">{shown.map((card) => <div key={card.status + ":" + card.id} className="contents">{card.node}</div>)}</section>}
    {footer}
    {(!agent || agent === "olivia") && <p className="rounded-2xl bg-paper p-3 text-sm text-ink-muted">{copy.transportUnavailable}</p>}
  </>;
}
