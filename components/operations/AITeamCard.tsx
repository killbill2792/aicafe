"use client";
import { useState } from "react";
import { ChevronRight, Pencil } from "lucide-react";
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
  const defaults: Record<AgentId, string> = { alex: "🧑🏽‍💼", olivia: "👩🏻‍💻", maya: "👩🏾‍🔬", leo: "🧔🏽‍♂️" };
  return <span className={`flex shrink-0 items-center justify-center rounded-full bg-card text-2xl ring-2 ring-white shadow-sm ${size === "large" ? "h-14 w-14" : "h-10 w-10"}`} aria-hidden="true">{defaults[agentId]}</span>;
}

const PRESETS = ["🧑🏽‍💼", "👩🏻‍💻", "👩🏾‍🔬", "🧔🏽‍♂️", "👨🏻‍🍳", "👩🏽‍🍳", "🤖", "🧑🏻‍🚀"];
function AvatarChoice({ agentId }: { agentId: AgentId }) { const defaults: Record<AgentId, string> = { alex: "🧑🏽‍💼", olivia: "👩🏻‍💻", maya: "👩🏾‍🔬", leo: "🧔🏽‍♂️" }; const [avatar, setAvatar] = useState(defaults[agentId]); const [open, setOpen] = useState(false); return <span className="relative"><span className="flex h-14 w-14 items-center justify-center rounded-full bg-card text-2xl ring-2 ring-white shadow-sm" aria-hidden>{avatar}</span><button type="button" onClick={(event) => { event.preventDefault(); setOpen((value) => !value); }} aria-label="Choose avatar" className="absolute -bottom-1 -end-1 flex h-7 w-7 items-center justify-center rounded-full bg-ink text-paper"><Pencil aria-hidden size={13}/></button>{open && <span className="absolute start-0 top-16 z-20 grid w-48 grid-cols-4 gap-2 rounded-2xl border border-line bg-card p-3 shadow-xl">{PRESETS.map((preset) => <button type="button" key={preset} title="Preview avatar; persistence is not connected yet" onClick={(event) => { event.preventDefault(); setAvatar(preset); setOpen(false); }} className="flex h-10 w-10 items-center justify-center rounded-full bg-paper text-xl">{preset}</button>)}</span>}</span>; }

type Copy = { title: string; aiLabel: string; brandLabel: string; names: Record<string, string>; roles: Record<string, string>; status: (member: TeamMemberState) => string };
export default function AITeamCard({ team, copy, selectedAgent, selectedStatus = "needs_you", major = false }: { team: OperationsTeamViewModel; copy: Copy; selectedAgent?: AgentId | null; selectedStatus?: "needs_you" | "handled" | "watching"; major?: boolean }) {
  return <section className={major ? "-mx-4 border-y border-[#D5C7B5] bg-[#EEE5D8] px-4 py-6 md:mx-0 md:rounded-card-lg md:border" : "rounded-card-lg border border-line bg-[#F1E9DE] p-[18px]"} aria-labelledby="ai-team-title">
    <div className="mb-4"><p className="text-sm font-bold text-ink-muted">{copy.brandLabel}</p><h2 id="ai-team-title" className={`${major ? "font-headline text-3xl" : "text-xl"} font-bold text-ink`}>{copy.title}</h2><p className="mt-1 text-[17px] text-ink-muted">{copy.aiLabel}</p></div>
    <div className="grid gap-2 sm:grid-cols-2">{team.members.map((member) => {
      const identity = agentIdentity[member.agentId];
      const selected = selectedAgent === member.agentId;
      return <div key={member.agentId} className={`flex min-h-[84px] items-center gap-3 rounded-2xl border-2 px-3 py-2 text-ink transition-colors ${identity.border} ${identity.surface} ${selected ? `ring-4 ring-offset-2 ${identity.ring}` : "hover:bg-card"}`}>
        <AvatarChoice agentId={member.agentId} />
        <Link href={{ pathname: "/operations", query: { agent: member.agentId, status: selectedStatus } }} aria-current={selected ? "page" : undefined} className="flex min-h-14 min-w-0 flex-1 items-center gap-2 text-ink no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"><span className="min-w-0 flex-1"><span className={`block text-lg font-extrabold ${identity.text}`}>{copy.names[member.agentId]}</span><span className="block text-sm text-ink-muted">{copy.roles[member.agentId]}</span><span className="block text-sm font-semibold text-ink">{copy.status(member)}</span></span><ChevronRight aria-hidden="true" size={20} className={`${identity.text} shrink-0 rtl:rotate-180`} /></Link>
      </div>;
    })}</div>
  </section>;
}
