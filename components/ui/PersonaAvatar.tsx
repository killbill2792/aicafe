import Image from "next/image";
import type { AgentId } from "@/lib/operating/tasks";
export function PersonaAvatar({agentId, size = 48}: {agentId: AgentId; size?: number}) { return <span className={`relative inline-flex shrink-0 items-end justify-center overflow-hidden rounded-full bg-persona-${agentId}-soft`} style={{height:size,width:size}}><Image src={`/ai-team/${agentId}.png`} alt="" width={size} height={size} sizes={`${size}px`} className="h-full w-full object-contain object-bottom"/></span>; }
