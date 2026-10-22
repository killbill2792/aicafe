import Image from "next/image";
import { CalendarCheck2, ChartNoAxesCombined, CircleDollarSign, Leaf } from "lucide-react";
import type { AgentId } from "@/lib/operating/tasks";

export const agentVisuals = {
  alex: {
    avatar: "/ai-team/alex.png",
    accent: "text-persona-alex",
    border: "border-persona-alex-border",
    softSurface: "bg-persona-alex-soft",
    strongSurface: "bg-persona-alex-soft",
    backdrop: "bg-persona-alex-soft",
    glow: "shadow-card",
    icon: ChartNoAxesCombined,
  },
  olivia: {
    avatar: "/ai-team/olivia.png",
    accent: "text-persona-olivia",
    border: "border-persona-olivia-border",
    softSurface: "bg-persona-olivia-soft",
    strongSurface: "bg-persona-olivia-soft",
    backdrop: "bg-persona-olivia-soft",
    glow: "shadow-card",
    icon: CalendarCheck2,
  },
  maya: {
    avatar: "/ai-team/maya.png",
    accent: "text-persona-maya",
    border: "border-persona-maya-border",
    softSurface: "bg-persona-maya-soft",
    strongSurface: "bg-persona-maya-soft",
    backdrop: "bg-persona-maya-soft",
    glow: "shadow-card",
    icon: Leaf,
  },
  leo: {
    avatar: "/ai-team/leo.png",
    accent: "text-persona-leo",
    border: "border-persona-leo-border",
    softSurface: "bg-persona-leo-soft",
    strongSurface: "bg-persona-leo-soft",
    backdrop: "bg-persona-leo-soft",
    glow: "shadow-card",
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
    <Image src={visual.avatar} alt="" fill sizes="(min-width: 768px) 190px, 72vw" className={`z-10 object-contain object-bottom drop-shadow-md transition-transform duration-200 motion-reduce:transition-none ${selected ? "scale-[1.05]" : "group-hover:scale-[1.02] group-focus-visible:scale-[1.02]"}`} />
  </span>;
}
