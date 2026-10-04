import { Check, ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { AgentId } from "@/lib/operating/tasks";
import type { TeamMemberState, OperationsTeamViewModel } from "@/lib/viewmodels/operationsTeam";
import { AgentAvatar, agentVisuals } from "@/components/operations/agentVisuals";

export { AgentAvatar, agentVisuals } from "@/components/operations/agentVisuals";

type Copy = { title: string; aiLabel: string; brandLabel: string; names: Record<string, string>; roles: Record<string, string>; status: (member: TeamMemberState) => string };
export default function AITeamCard({ team, copy, selectedAgent, selectedStatus, major = false }: { team: OperationsTeamViewModel; copy: Copy; selectedAgent?: AgentId | null; selectedStatus?: "needs_you" | "handled" | "watching"; major?: boolean }) {
  return <section className={major ? "-mx-4 border-y border-[#D5C7B5] bg-[#EEE5D8] px-4 py-6 md:mx-0 md:rounded-card-lg md:border" : "rounded-card-lg border border-line bg-[#F1E9DE] p-[18px]"} aria-labelledby="ai-team-title">
    <div className="mb-4"><p className="text-sm font-bold text-ink-muted">{copy.brandLabel}</p><h2 id="ai-team-title" className={`${major ? "font-headline text-3xl" : "text-xl"} font-bold text-ink`}>{copy.title}</h2><p className="mt-1 text-[17px] text-ink-muted">{copy.aiLabel}</p></div>
    <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-5 pt-2 md:mx-0 md:grid md:grid-cols-4 md:overflow-visible md:px-0">{team.members.map((member) => {
      const visual = agentVisuals[member.agentId];
      const selected = selectedAgent === member.agentId;
      const Icon = visual.icon;
      return <Link key={member.agentId} href={{ pathname: "/operations", query: { ...(selected ? {} : { agent: member.agentId }), ...(selectedStatus ? { status: selectedStatus } : {}) } }} aria-current={selected ? "page" : undefined} className={`group relative flex w-[76vw] min-w-[250px] max-w-[290px] shrink-0 snap-center flex-col pt-1 text-ink no-underline transition-transform duration-200 hover:-translate-y-1 focus-visible:-translate-y-1 focus-visible:rounded-3xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-reduce:transform-none motion-reduce:transition-none md:w-auto md:min-w-0 ${selected ? "-translate-y-1" : ""}`}>
        <AgentAvatar agentId={member.agentId} selected={selected} />
        <span className={`relative z-20 -mt-5 flex min-h-[154px] flex-col rounded-[22px] px-4 pb-4 pt-7 transition-shadow duration-200 motion-reduce:transition-none ${selected ? `${visual.strongSurface} ${visual.glow} shadow-xl` : `${visual.softSurface} shadow-[0_10px_26px_rgba(42,29,20,0.12)] group-hover:shadow-lg`}`}>
          {selected && <span className="absolute inset-x-3 -top-5 flex min-h-10 items-center justify-center gap-2 rounded-full bg-ink px-3 text-[17px] font-extrabold text-paper shadow-md"><Check aria-hidden="true" size={19} strokeWidth={3} />{copy.names[member.agentId]}</span>}
          <span className="flex items-start gap-2">
            <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-card/80 ${visual.accent}`}><Icon aria-hidden="true" size={24} strokeWidth={2.5} /></span>
            <span className="min-w-0 flex-1"><span className={`block text-xl font-extrabold ${visual.accent}`}>{copy.names[member.agentId]}</span><span className={`block text-[15px] font-bold leading-tight ${visual.accent}`}>{copy.roles[member.agentId]}</span></span>
            <ChevronRight aria-hidden="true" size={20} className={`mt-2 shrink-0 ${visual.accent} rtl:rotate-180`} />
          </span>
          <span className="mt-3 block text-[17px] font-semibold leading-snug text-ink">{copy.status(member)}</span>
        </span>
      </Link>;
    })}</div>
  </section>;
}
