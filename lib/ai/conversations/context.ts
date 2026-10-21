import {validatedOwnerAnswerText} from "@/lib/ai/supervisor/ownerInput/proposalContext";
import type { ConversationMessage, SupervisorReplyBlock } from "./contracts";

export type ConversationalTurn = { role: "owner" | "supervisor"; text: string };
/** Only display-safe content from the last few messages; no hidden IDs or grounding metadata. */
export function compactConversationContext(messages: ConversationMessage[], currentId: string): ConversationalTurn[] {
  return messages.filter((message) => message.id !== currentId)
    .slice(-12).map((message) => {
      if (message.role === "owner") return { role: "owner" as const, text:
        (message.ownerInputResponse?
          validatedOwnerAnswerText(messages,message)??"":
          message.text??"").slice(0,650) };
      const parts = (message.blocks ?? []).slice(0, 10).flatMap((raw): string[] => {
        if (!raw || typeof raw !== "object") return [];
        const block = raw as SupervisorReplyBlock;
        if (block.type === "text" || block.type === "warning") return [block.text.slice(0, 300)];
        if (block.type === "metric") return [block.label + ": " + (block.valueCents / 100).toFixed(2) + " (currency)"];
        if (block.type === "count") return [block.label + ": " + block.value];
        if (block.type === "task_card") return [block.agent + ": " + block.title + " (" + block.status + ")"];
        if (block.type === "task_status") return ["Task status: " + block.status];
        return [];
      });
      return { role: "supervisor" as const, text: parts.join("; ").slice(0, 850) };
    }).filter((item) => item.text.trim() !== "");
}
