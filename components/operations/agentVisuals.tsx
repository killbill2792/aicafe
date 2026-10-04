import Image from "next/image";
import { CalendarCheck2, ChartNoAxesCombined, CircleDollarSign, Leaf } from "lucide-react";
import type { AgentId } from "@/lib/operating/tasks";

export const agentVisuals = {
  alex: {
    avatar: "/ai-team/alex.svg",
    accent: "text-[#276A9E]",
    border: "border-[#65A6D5]",
    softSurface: "bg-[#EAF5FC]",
    strongSurface: "bg-[#D9EEFA]",
    backdrop: "bg-[#BDE1F6]",
    glow: "shadow-[0_16px_42px_rgba(39,106,158,0.28)]",
    icon: ChartNoAxesCombined,
  },
  olivia: {
    avatar: "/ai-team/olivia.svg",
    accent: "text-[#74488A]",
    border: "border-[#A982BA]",
    softSurface: "bg-[#F5EDF8]",
    strongSurface: "bg-[#EEDDF4]",
    backdrop: "bg-[#DEC5EA]",
    glow: "shadow-[0_16px_42px_rgba(116,72,138,0.27)]",
    icon: CalendarCheck2,
  },
  maya: {
    avatar: "/ai-team/maya.svg",
    accent: "text-[#287852]",
    border: "border-[#75AD8B]",
    softSurface: "bg-[#ECF6EF]",
    strongSurface: "bg-[#DDF0E3]",
    backdrop: "bg-[#C6E8D0]",
    glow: "shadow-[0_16px_42px_rgba(40,120,82,0.27)]",
    icon: Leaf,
  },
  leo: {
    avatar: "/ai-team/leo.svg",
    accent: "text-[#8A5C00]",
    border: "border-[#D6A43D]",
    softSurface: "bg-[#FFF6DF]",
    strongSurface: "bg-[#FBEBC2]",
    backdrop: "bg-[#F8D98A]",
    glow: "shadow-[0_16px_42px_rgba(173,116,0,0.27)]",
    icon: CircleDollarSign,
  },
} satisfies Record<AgentId, {
  avatar: string;
  accent: string;
  border: string;
  softSurface: string;
  strongSurface: string;
  backdrop: string;
  glow: string;
  icon: typeof ChartNoAxesCombined;
}>;

export function AgentAvatar({ agentId, size = "hero", selected = false }: { agentId: AgentId; size?: "hero" | "task"; selected?: boolean }) {
  const visual = agentVisuals[agentId];

  if (size === "task") {
    return <span className={`relative flex h-12 w-12 shrink-0 items-end justify-center overflow-hidden rounded-full ${visual.backdrop}`} aria-hidden="true">
      <Image src={visual.avatar} alt="" width={48} height={64} sizes="48px" className="h-[58px] w-auto max-w-none object-contain object-bottom" />
    </span>;
  }

  return <span className="relative block h-52 w-full" aria-hidden="true">
    <span className={`absolute inset-x-[9%] bottom-2 top-4 rounded-[48%_52%_44%_56%/54%_42%_58%_46%] transition-all duration-200 motion-reduce:transition-none ${visual.backdrop} ${selected ? `${visual.glow} scale-[1.04]` : "group-hover:scale-[1.02] group-hover:brightness-[1.03] group-hover:shadow-lg group-focus-visible:scale-[1.02] group-focus-visible:brightness-[1.03] group-focus-visible:shadow-lg"}`} />
    <Image src={visual.avatar} alt="" fill sizes="(min-width: 768px) 190px, 72vw" className={`z-10 object-contain object-bottom drop-shadow-[0_12px_12px_rgba(42,29,20,0.18)] transition-transform duration-200 motion-reduce:transition-none ${selected ? "scale-[1.05]" : "group-hover:scale-[1.02] group-focus-visible:scale-[1.02]"}`} />
  </span>;
}
