import { Bot, ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { TeamMemberState, OperationsTeamViewModel } from "@/lib/viewmodels/operationsTeam";

type Copy = { title: string; aiLabel: string; names: Record<string, string>; roles: Record<string, string>; status: (member: TeamMemberState) => string };
export default function AITeamCard({ team, copy }: { team: OperationsTeamViewModel; copy: Copy }) {
  return <section className="rounded-card-lg bg-card p-[18px]" aria-labelledby="ai-team-title">
    <div className="mb-3 flex items-center justify-between gap-3"><div><h2 id="ai-team-title" className="text-lg font-bold text-ink">{copy.title}</h2><p className="text-sm text-ink-muted">{copy.aiLabel}</p></div><Bot aria-hidden="true" className="text-ink-muted" /></div>
    <div className="grid gap-1 sm:grid-cols-2">{team.members.map((member) => <Link key={member.agentId} href={{ pathname: "/operations", query: { agent: member.agentId } }} className="flex min-h-16 items-center gap-3 rounded-2xl px-2 py-2 text-ink no-underline hover:bg-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-paper font-headline text-lg font-bold" aria-hidden="true">{copy.names[member.agentId].slice(0, 1)}</span>
      <span className="min-w-0 flex-1"><span className="block font-bold">{copy.names[member.agentId]}</span><span className="block text-sm text-ink-muted">{copy.roles[member.agentId]}</span><span className="block text-sm font-semibold">{copy.status(member)}</span></span><ChevronRight aria-hidden="true" size={18} className="shrink-0 text-ink-muted rtl:rotate-180" />
    </Link>)}</div>
  </section>;
}
