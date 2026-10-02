import { ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { AgentId } from "@/lib/operating/tasks";
import type { TeamMemberState, OperationsTeamViewModel } from "@/lib/viewmodels/operationsTeam";

export const agentIdentity: Record<AgentId, { border: string; surface: string; text: string; ring: string }> = {
  alex: { border: "border-[#5879A6]", surface: "bg-[#E8EEF6]", text: "text-[#294E7A]", ring: "ring-[#5879A6]" },
  olivia: { border: "border-[#8A668B]", surface: "bg-[#F1E8F1]", text: "text-[#674568]", ring: "ring-[#8A668B]" },
  maya: { border: "border-[#A66845]", surface: "bg-[#F5E9E1]", text: "text-[#78462C]", ring: "ring-[#A66845]" },
  leo: { border: "border-[#A67C2D]", surface: "bg-[#F4ECD8]", text: "text-[#76561C]", ring: "ring-[#A67C2D]" },
};

export function AgentAvatar({ agentId, size = "large" }: { agentId: AgentId; size?: "small" | "large" }) {
  const details: Record<AgentId, { initials: string; hair: string; shirt: string }> = {
    alex: { initials: "A", hair: "bg-[#46362D]", shirt: "bg-[#5879A6]" },
    olivia: { initials: "O", hair: "bg-[#6C4938]", shirt: "bg-[#8A668B]" },
    maya: { initials: "M", hair: "bg-[#2F2925]", shirt: "bg-[#A66845]" },
    leo: { initials: "L", hair: "bg-[#70513B]", shirt: "bg-[#A67C2D]" },
  };
  const detail = details[agentId];
  return <span className={`relative shrink-0 overflow-hidden rounded-full bg-[#EBCBB0] ring-2 ring-card ${size === "large" ? "h-12 w-12" : "h-9 w-9"}`} aria-hidden="true">
    <span className={`absolute inset-x-0 top-0 h-[34%] rounded-b-full ${detail.hair}`} />
    <span className="absolute inset-x-0 top-[28%] text-center text-sm font-black text-[#553B2A]">{detail.initials}</span>
    <span className={`absolute -bottom-[22%] start-[14%] h-[55%] w-[72%] rounded-t-full ${detail.shirt}`} />
  </span>;
}

type Copy = { title: string; aiLabel: string; names: Record<string, string>; roles: Record<string, string>; status: (member: TeamMemberState) => string };
export default function AITeamCard({ team, copy, selectedAgent, major = false }: { team: OperationsTeamViewModel; copy: Copy; selectedAgent?: AgentId | null; major?: boolean }) {
  return <section className={major ? "-mx-4 border-y border-[#D5C7B5] bg-[#EEE5D8] px-4 py-6 md:mx-0 md:rounded-card-lg md:border" : "rounded-card-lg border border-line bg-[#F1E9DE] p-[18px]"} aria-labelledby="ai-team-title">
    <div className="mb-4"><p className="text-sm font-bold text-ink-muted">AI · CAFÉ PROFIT</p><h2 id="ai-team-title" className={`${major ? "font-headline text-3xl" : "text-xl"} font-bold text-ink`}>{copy.title}</h2><p className="mt-1 text-[17px] text-ink-muted">{copy.aiLabel}</p></div>
    <div className="grid gap-2 sm:grid-cols-2">{team.members.map((member) => {
      const identity = agentIdentity[member.agentId];
      const selected = selectedAgent === member.agentId;
      return <Link key={member.agentId} href={{ pathname: "/operations", query: { agent: member.agentId } }} aria-current={selected ? "page" : undefined} className={`flex min-h-[84px] items-center gap-3 rounded-2xl border-2 px-3 py-2 text-ink no-underline transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${identity.border} ${identity.surface} ${selected ? `ring-4 ring-offset-2 ${identity.ring}` : "hover:bg-card"}`}>
        <AgentAvatar agentId={member.agentId} />
        <span className="min-w-0 flex-1"><span className={`block text-lg font-extrabold ${identity.text}`}>{copy.names[member.agentId]}</span><span className="block text-sm text-ink-muted">{copy.roles[member.agentId]}</span><span className="block text-sm font-semibold text-ink">{copy.status(member)}</span></span><ChevronRight aria-hidden="true" size={20} className={`${identity.text} shrink-0 rtl:rotate-180`} />
      </Link>;
    })}</div>
  </section>;
}
