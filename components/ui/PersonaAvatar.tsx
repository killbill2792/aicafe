import Image from "next/image";
import type { AgentId } from "@/lib/operating/tasks";
const soft: Record<AgentId,string> = {alex:"bg-persona-alex-soft",olivia:"bg-persona-olivia-soft",maya:"bg-persona-maya-soft",leo:"bg-persona-leo-soft"};
export function PersonaAvatar({agentId, size = 48}: {agentId: AgentId; size?: number}) { return <span className={`relative inline-flex shrink-0 items-end justify-center overflow-hidden rounded-full ${soft[agentId]}`} style={{height:size,width:size}}><Image src={`/ai-team/${agentId}.png`} alt="" width={size} height={size} sizes={`${size}px`} className="h-full w-full object-contain object-bottom"/></span>; }
